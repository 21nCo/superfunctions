from typing import List, Optional
import psycopg
from pgvector.psycopg import register_vector
from memoryfn.core.types import Memory, MemoryRelationship
import json
from datetime import datetime

class PostgresAdapter:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self._conn = None

    async def connect(self):
        if not self._conn:
            # Note: In a real async app we'd use psycopg_pool or AsyncConnection
            # Here we use standard sync connection for simplicity or psycopg.AsyncConnection
            self._conn = await psycopg.AsyncConnection.connect(self.dsn, autocommit=True)
            # Enable vector extension support
            await register_vector(self._conn)

    async def insert_memories(self, memories: List[Memory]) -> List[Memory]:
        await self.connect()
        async with self._conn.cursor() as cur:
            results = []
            for mem in memories:
                # Using timestamp in ms for domain, but DB uses timestamptz
                created_at = datetime.fromtimestamp(mem.created_at / 1000.0)
                updated_at = datetime.fromtimestamp(mem.updated_at / 1000.0)
                
                await cur.execute(
                    """
                    INSERT INTO memories (
                        tenant_id, container_tags, type, content, embedding, 
                        metadata, is_latest, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        mem.tenant_id,
                        mem.container_tags,
                        mem.type,
                        mem.content,
                        mem.embedding,
                        json.dumps(mem.metadata),
                        mem.is_latest,
                        created_at,
                        updated_at
                    )
                )
                row = await cur.fetchone()
                mem.id = str(row[0])
                results.append(mem)
            return results

    async def insert_relationships(self, relationships: List[MemoryRelationship]) -> List[MemoryRelationship]:
        await self.connect()
        async with self._conn.cursor() as cur:
            results = []
            for rel in relationships:
                created_at = datetime.fromtimestamp(rel.created_at / 1000.0)
                await cur.execute(
                    """
                    INSERT INTO memory_relationships (
                        from_id, to_id, type, confidence, reasoning, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        rel.from_id,
                        rel.to_id,
                        rel.type,
                        rel.confidence,
                        rel.reasoning,
                        created_at
                    )
                )
                row = await cur.fetchone()
                rel.id = str(row[0])
                results.append(rel)
            return results

    async def search_vectors(
        self, 
        embedding: List[float], 
        container_tags: List[str], 
        top_k: int = 10,
        threshold: float = 0.7
    ) -> List[Memory]:
        await self.connect()
        
        # Build query
        # Using <=> for cosine distance. Distance = 1 - similarity.
        # Similarity >= threshold  =>  Distance <= 1 - threshold
        max_dist = 1.0 - threshold
        
        query = """
            SELECT id, tenant_id, container_tags, type, content, embedding, 
                   metadata, is_latest, created_at, updated_at,
                   1 - (embedding <=> %s::vector) as similarity
            FROM memories
            WHERE 1=1
        """
        params = [embedding]
        
        if container_tags:
            query += " AND container_tags && %s"
            params.append(container_tags)
            
        if threshold:
            query += f" AND (embedding <=> %s::vector) <= {max_dist}"
            params.append(embedding)
            
        query += " ORDER BY embedding <=> %s::vector LIMIT %s"
        params.extend([embedding, top_k])
        
        async with self._conn.cursor() as cur:
            await cur.execute(query, params)
            rows = await cur.fetchall()
            
            results = []
            for row in rows:
                results.append(Memory(
                    id=str(row[0]),
                    tenantId=row[1],
                    containerTags=row[2],
                    type=row[3],
                    content=row[4],
                    embedding=row[5].tolist() if hasattr(row[5], 'tolist') else row[5],
                    metadata=row[6],
                    isLatest=row[7],
                    createdAt=row[8].timestamp() * 1000,
                    updatedAt=row[9].timestamp() * 1000
                ))
            return results
    
    async def close(self):
        if self._conn:
            await self._conn.close()
