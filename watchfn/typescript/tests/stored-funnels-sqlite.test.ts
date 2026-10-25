import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { WatchFn } from '../src/core/watch-fn';
import { getWatchFnSchema } from '../src/storage/schema';
import { getBusinessSchema } from '../src/business/schema';
const watches:WatchFn[]=[],databases:Kysely<any>[]=[],directories:string[]=[];
afterEach(async()=>{for(const watch of watches.splice(0)){await watch.flush().catch(()=>{});await watch.stop().catch(()=>{});}for(const db of databases.splice(0))await db.destroy();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
it('reopens definitions and actual business.track events through the shared SQLite adapter',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'watch-funnel-'));directories.push(directory);const filename=join(directory,'db.sqlite');
 const schema={...getWatchFnSchema(),...getBusinessSchema()};
 const connect=()=>{const native=new Database(filename);native.pragma('journal_mode=WAL');const sql=new Kysely<any>({dialect:new SqliteDialect({database:native})});databases.push(sql);return sql;};
 const sql=connect();for(const [name,table]of Object.entries(schema)){let migration=sql.schema.createTable(name);for(const [field,options]of Object.entries(table.fields))migration=migration.addColumn(field,options.type==='number'?'integer':'text',column=>field==='id'?column.primaryKey():options.required?column.notNull():column);await migration.execute();}
 const create=(name='store')=>{const database=kyselyAdapter({db:connect(),dialect:'sqlite',schema:Object.fromEntries(Object.keys(schema).map(key=>[key,key]))});const watch=new WatchFn({name,storage:'database',database,infra:{enabled:false}});watches.push(watch);watch.start();return watch;};
 const first=create();await first.business.createFunnel({name:'checkout',steps:[{event:'page'},{event:'paid'}],timeWindow:'1h'});
 first.business.track('page',{userId:'buyer'});await first.flush();await new Promise(resolve=>setTimeout(resolve,3));first.business.track('paid',{userId:'buyer'});await first.flush();await first.stop();
 const foreign=create('different');foreign.business.track('page',{userId:'other'});await foreign.flush();await new Promise(resolve=>setTimeout(resolve,2));foreign.business.track('paid',{userId:'other'});await foreign.flush();
 const reopened=create();const result=await reopened.business.getFunnel({name:'checkout',timeRange:'last-1h'});expect(result.steps.map(step=>step.count)).toEqual([1,1]);expect(result.overallConversion).toBe(100);
 await expect(create('different').business.getFunnel({name:'checkout',timeRange:'last-1h'})).rejects.toThrow('not found');
 const another=create();const duplicates=await Promise.allSettled([reopened.business.createFunnel({name:'race',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'}),another.business.createFunnel({name:'race',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'})]);expect(duplicates.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});
