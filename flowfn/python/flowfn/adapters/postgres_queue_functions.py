"""Single-roundtrip atomic operations for independent PostgreSQL queue jobs."""
SCHEMA = r'''
CREATE OR REPLACE FUNCTION flowfn_py_enqueue_v2(p_namespace TEXT,p_queue TEXT,p_lock TEXT,p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE existing JSONB; stamp BIGINT; due_at BIGINT; identity TEXT; dedup_key TEXT; status TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock,2));
  identity:=p_payload->>'id';
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_namespace,p_queue,identity)::text,4));
  SELECT payload INTO existing FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND id=identity;
  IF FOUND THEN RETURN existing; END IF;
  dedup_key:=p_payload->'opts'->>'deduplication_key';
  IF dedup_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_namespace,p_queue,dedup_key)::text,5)); END IF;
  IF (p_payload->'opts'->>'prevent_duplicates')::boolean AND dedup_key IS NOT NULL THEN
    SELECT payload INTO existing FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND dedup=dedup_key AND state NOT IN ('completed','failed') ORDER BY sequence LIMIT 1;
    IF FOUND THEN RETURN existing; END IF;
  END IF;
  stamp:=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint;
  due_at:=COALESCE((p_payload->>'available_at')::bigint,(p_payload->>'timestamp')::bigint+(p_payload->>'delay')::bigint);
  IF (p_payload->>'delay')::bigint=0 AND due_at<=(p_payload->>'timestamp')::bigint THEN
    due_at:=stamp;
    p_payload:=jsonb_set(p_payload,'{available_at}',to_jsonb(stamp));
  END IF;
  status:=p_payload->>'state';
  INSERT INTO flowfn_py_jobs(namespace,queue,id,state,priority,due,lease,dedup,has_dependencies,payload)
    VALUES(p_namespace,p_queue,identity,status,(p_payload->'opts'->>'priority')::integer,due_at,(p_payload->>'lease_expires_at')::bigint,dedup_key,false,p_payload);
  RETURN p_payload;
END $$;

CREATE OR REPLACE FUNCTION flowfn_py_dequeue_v2(p_namespace TEXT,p_queue TEXT,p_lock TEXT,p_token TEXT,p_lease BIGINT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE selected flowfn_py_jobs%ROWTYPE; stamp BIGINT; expires BIGINT; result JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock,2));
  stamp:=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint;
  IF EXISTS(SELECT 1 FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND has_dependencies AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND state='active' AND lease<=stamp) THEN
    RETURN jsonb_build_object('kind','fallback');
  END IF;
  SELECT * INTO selected FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND state IN ('waiting','delayed') AND NOT has_dependencies AND due<=stamp ORDER BY priority,sequence LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','empty'); END IF;
  IF selected.payload->'opts'->'backoff'->>'type'='custom' THEN RETURN jsonb_build_object('kind','fallback'); END IF;
  expires:=stamp+p_lease;
  result:=selected.payload || jsonb_build_object('state','active','lease_token',p_token,'lease_expires_at',expires);
  UPDATE flowfn_py_jobs SET state='active',lease=expires,payload=result WHERE namespace=p_namespace AND queue=p_queue AND id=selected.id;
  RETURN jsonb_build_object('kind','claimed','job',result);
END $$;

CREATE OR REPLACE FUNCTION flowfn_py_renew_v2(p_namespace TEXT,p_queue TEXT,p_lock TEXT,p_id TEXT,p_token TEXT,p_lease BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE stamp BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock,2));
  PERFORM 1 FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND id=p_id FOR UPDATE;
  stamp:=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint;
  UPDATE flowfn_py_jobs SET lease=stamp+p_lease,payload=jsonb_set(payload,'{lease_expires_at}',to_jsonb(stamp+p_lease))
    WHERE namespace=p_namespace AND queue=p_queue AND id=p_id AND state='active' AND lease>stamp AND payload->>'lease_token'=p_token;
  RETURN FOUND;
END $$;
'''

SCHEMA += r'''
CREATE OR REPLACE FUNCTION flowfn_py_update_v2(p_namespace TEXT,p_queue TEXT,p_lock TEXT,p_payload JSONB,p_lease BIGINT,p_dlq JSONB) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE selected flowfn_py_jobs%ROWTYPE; stamp BIGINT; policy JSONB; status TEXT; due_at BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock,2));
  SELECT * INTO selected FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND id=p_payload->>'id' FOR UPDATE;
  stamp:=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint;
  IF NOT FOUND OR selected.state<>'active' OR selected.lease IS NULL OR selected.lease<=stamp OR selected.payload->>'lease_token' IS DISTINCT FROM p_payload->>'lease_token' THEN RETURN 0; END IF;
  IF EXISTS(SELECT 1 FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND has_dependencies AND state NOT IN ('completed','failed')) THEN RETURN 2; END IF;
  status:=p_payload->>'state';
  policy:=CASE WHEN status='completed' THEN p_payload->'opts'->'remove_on_complete' WHEN status='failed' THEN p_payload->'opts'->'remove_on_fail' ELSE 'false'::jsonb END;
  IF jsonb_typeof(policy)='number' THEN RETURN 2; END IF;
  IF policy='true'::jsonb THEN
    DELETE FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND id=selected.id;
  ELSE
    IF status='active' THEN p_payload:=jsonb_set(p_payload,'{lease_expires_at}',to_jsonb(stamp+p_lease)); END IF;
    due_at:=COALESCE((p_payload->>'available_at')::bigint,(p_payload->>'timestamp')::bigint+(p_payload->>'delay')::bigint);
    UPDATE flowfn_py_jobs SET state=status,priority=(p_payload->'opts'->>'priority')::integer,due=due_at,
      lease=(p_payload->>'lease_expires_at')::bigint,dedup=p_payload->'opts'->>'deduplication_key',payload=p_payload
      WHERE namespace=p_namespace AND queue=p_queue AND id=selected.id;
  END IF;
  IF status='failed' THEN
    INSERT INTO flowfn_py_dead_letters VALUES(p_namespace,p_queue,selected.id,p_dlq)
      ON CONFLICT(namespace,queue,id) DO UPDATE SET payload=EXCLUDED.payload;
  END IF;
  RETURN 1;
END $$;
'''

SCHEMA += r'''
CREATE OR REPLACE FUNCTION flowfn_py_apply_v2(p_namespace TEXT,p_queue TEXT,p_delta JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE item JSONB; identity TEXT; status TEXT;
BEGIN
  DELETE FROM flowfn_py_jobs WHERE namespace=p_namespace AND queue=p_queue AND id IN (SELECT jsonb_array_elements_text(p_delta->'delete_jobs'));
  DELETE FROM flowfn_py_job_edges WHERE namespace=p_namespace AND queue=p_queue AND child IN (SELECT jsonb_array_elements_text(p_delta->'delete_jobs'));
  FOR item IN SELECT value FROM jsonb_array_elements(p_delta->'jobs') LOOP
    identity:=item->>'id'; status:=item->>'state';
    INSERT INTO flowfn_py_jobs(namespace,queue,id,state,priority,due,lease,dedup,has_dependencies,payload)
      VALUES(p_namespace,p_queue,identity,status,(item->'opts'->>'priority')::integer,
        COALESCE((item->>'available_at')::bigint,(item->>'timestamp')::bigint+(item->>'delay')::bigint),
        (item->>'lease_expires_at')::bigint,item->'opts'->>'deduplication_key',
        COALESCE(jsonb_array_length(NULLIF(item->'opts'->'wait_for','null'::jsonb)),0)>0,item)
      ON CONFLICT(namespace,queue,id) DO UPDATE SET state=EXCLUDED.state,priority=EXCLUDED.priority,due=EXCLUDED.due,
        lease=EXCLUDED.lease,dedup=EXCLUDED.dedup,has_dependencies=EXCLUDED.has_dependencies,payload=EXCLUDED.payload;
    DELETE FROM flowfn_py_job_edges WHERE namespace=p_namespace AND queue=p_queue AND child=identity;
    IF status NOT IN ('completed','failed') THEN
      INSERT INTO flowfn_py_job_edges SELECT DISTINCT p_namespace,p_queue,identity,value FROM jsonb_array_elements_text(COALESCE(NULLIF(item->'opts'->'wait_for','null'::jsonb),'[]'::jsonb)) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  DELETE FROM flowfn_py_job_outcomes WHERE namespace=p_namespace AND queue=p_queue AND id IN (SELECT jsonb_array_elements_text(p_delta->'delete_outcomes'));
  FOR item IN SELECT value FROM jsonb_array_elements(p_delta->'outcomes') LOOP
    INSERT INTO flowfn_py_job_outcomes VALUES(p_namespace,p_queue,item->>'id',item->>'state')
      ON CONFLICT(namespace,queue,id) DO UPDATE SET state=EXCLUDED.state;
  END LOOP;
  DELETE FROM flowfn_py_dead_letters WHERE namespace=p_namespace AND queue=p_queue AND id IN (SELECT jsonb_array_elements_text(p_delta->'delete_dlq'));
  FOR item IN SELECT value FROM jsonb_array_elements(p_delta->'dlq') LOOP
    INSERT INTO flowfn_py_dead_letters VALUES(p_namespace,p_queue,item->>'id',item)
      ON CONFLICT(namespace,queue,id) DO UPDATE SET payload=EXCLUDED.payload;
  END LOOP;
END $$;
'''
