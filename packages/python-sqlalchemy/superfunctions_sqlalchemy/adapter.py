"""SQLAlchemy adapter implementation."""

import time
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import MetaData, Table, and_, delete, func, insert, or_, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError
from superfunctions.db import (
    Adapter,
    AdapterCapabilities,
    ConnectionError,
    ConstraintViolationError,
    CountParams,
    CreateManyParams,
    CreateParams,
    CreateSchemaParams,
    DeleteManyParams,
    DeleteParams,
    DuplicateKeyError,
    FindManyParams,
    FindOneParams,
    HealthStatus,
    NotFoundError,
    Operator,
    QueryFailedError,
    SchemaCreation,
    TableSchema,
    TransactionAdapter,
    UpdateManyParams,
    UpdateParams,
    UpsertParams,
    ValidationResult,
    WhereClause,
)


class SQLAlchemyAdapter:
    """SQLAlchemy adapter for superfunctions.db"""

    def __init__(self, engine: Engine, namespace_prefix: str = ""):
        """
        Initialize SQLAlchemy adapter.
        
        Args:
            engine: SQLAlchemy Engine
            namespace_prefix: Prefix for table names (for namespacing)
        """
        self.engine = engine
        self.namespace_prefix = namespace_prefix
        self.metadata = MetaData()
        self._start_time = time.time()
        
        # Metadata
        self.id = "sqlalchemy"
        self.name = "SQLAlchemy Adapter"
        self.version = "0.1.0"
        self.capabilities = AdapterCapabilities(
            transactions=True,
            nested_transactions=True,
            joins=True,
            full_text_search=False,
            json_operations=True,
            schema_management=True,
            migration_support=False,
            batch_operations=True,
        )

    def _get_table_name(self, model: str, namespace: Optional[str] = None) -> str:
        """Get full table name with namespace."""
        parts = [part for part in (self.namespace_prefix, namespace, model) if part]
        return "_".join(parts)

    def _build_where_clause(self, table: Table, where: List[WhereClause]) -> Any:
        """Build SQLAlchemy where clause from WhereClause list."""
        if not where:
            return None
        
        conditions = []
        for clause in where:
            column = getattr(table.c, clause.field)
            
            if clause.operator == Operator.EQ:
                conditions.append(column == clause.value)
            elif clause.operator == Operator.NE:
                conditions.append(column != clause.value)
            elif clause.operator == Operator.GT:
                conditions.append(column > clause.value)
            elif clause.operator == Operator.GTE:
                conditions.append(column >= clause.value)
            elif clause.operator == Operator.LT:
                conditions.append(column < clause.value)
            elif clause.operator == Operator.LTE:
                conditions.append(column <= clause.value)
            elif clause.operator == Operator.IN:
                conditions.append(column.in_(clause.value))
            elif clause.operator == Operator.NOT_IN:
                conditions.append(column.notin_(clause.value))
            elif clause.operator == Operator.LIKE:
                conditions.append(column.like(clause.value))
            elif clause.operator == Operator.ILIKE:
                conditions.append(column.ilike(clause.value))
            elif clause.operator == Operator.IS_NULL:
                conditions.append(column.is_(None))
            elif clause.operator == Operator.IS_NOT_NULL:
                conditions.append(column.isnot(None))
            elif clause.operator == Operator.CONTAINS:
                conditions.append(column.contains(clause.value))
            elif clause.operator == Operator.STARTS_WITH:
                conditions.append(column.startswith(clause.value))
            elif clause.operator == Operator.ENDS_WITH:
                conditions.append(column.endswith(clause.value))
        
        return and_(*conditions) if len(conditions) > 1 else conditions[0]

    def _get_table(self, model: str, namespace: Optional[str] = None) -> Table:
        """Get or reflect table from database."""
        table_name = self._get_table_name(model, namespace)
        
        if table_name in self.metadata.tables:
            return self.metadata.tables[table_name]
        
        # Reflect table from database
        return Table(table_name, self.metadata, autoload_with=self.engine)

    def _apply_where(self, query: Any, where_clause: Any) -> Any:
        if where_clause is None:
            return query
        return query.where(where_clause)

    def _apply_select(self, table: Table, params: FindOneParams | FindManyParams) -> Any:
        columns = [getattr(table.c, field) for field in params.select] if params.select else [table]
        return select(*columns).select_from(table)

    async def _create(self, params: CreateParams, connection=None) -> Dict[str, Any]:
        """Create a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            conn = connection
            if conn is not None:
                conn.execute(insert(table).values(**params.data))
                row = conn.execute(
                    self._apply_where(select(table), self._build_where_clause(table, [WhereClause(field=key, operator=Operator.EQ, value=value) for key, value in params.data.items()]))
                ).fetchone()
                return dict(row._mapping) if row else params.data

            with self.engine.begin() as managed_conn:
                return await self._create(params, managed_conn)
        
        except IntegrityError as e:
            if "unique" in str(e).lower() or "duplicate" in str(e).lower():
                raise DuplicateKeyError(str(e), cause=e)
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"Create failed: {str(e)}", cause=e)

    async def create(self, params: CreateParams) -> Dict[str, Any]:
        return await self._create(params)

    async def _find_one(self, params: FindOneParams, connection=None) -> Optional[Dict[str, Any]]:
        """Find a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where) if params.where else None
            query = self._apply_where(self._apply_select(table, params), where_clause)

            conn = connection
            if conn is not None:
                row = conn.execute(query).fetchone()
                return dict(row._mapping) if row else None

            with self.engine.connect() as managed_conn:
                return await self._find_one(params, managed_conn)
        
        except Exception as e:
            raise QueryFailedError(f"FindOne failed: {str(e)}", cause=e)

    async def find_one(self, params: FindOneParams) -> Optional[Dict[str, Any]]:
        return await self._find_one(params)

    async def _find_many(self, params: FindManyParams, connection=None) -> List[Dict[str, Any]]:
        """Find multiple records."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where) if params.where else None
            query = self._apply_where(self._apply_select(table, params), where_clause)
            
            if params.order_by:
                for order in params.order_by:
                    column = getattr(table.c, order.field)
                    query = query.order_by(column.desc() if order.direction == "desc" else column)
            
            if params.limit:
                query = query.limit(params.limit)
            
            if params.offset:
                query = query.offset(params.offset)

            conn = connection
            if conn is not None:
                result = conn.execute(query)
                return [dict(row._mapping) for row in result.fetchall()]

            with self.engine.connect() as managed_conn:
                return await self._find_many(params, managed_conn)
        
        except Exception as e:
            raise QueryFailedError(f"FindMany failed: {str(e)}", cause=e)

    async def find_many(self, params: FindManyParams) -> List[Dict[str, Any]]:
        return await self._find_many(params)

    async def _update(self, params: UpdateParams, connection=None) -> Dict[str, Any]:
        """Update a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)

            conn = connection
            if conn is not None:
                result = conn.execute(update(table).where(where_clause).values(**params.data))
                if result.rowcount == 0:
                    raise NotFoundError(f"Record not found for update")
                row = conn.execute(self._apply_where(select(table), where_clause)).fetchone()
                if not row:
                    raise NotFoundError(f"Record not found for update")
                return dict(row._mapping)

            with self.engine.begin() as managed_conn:
                return await self._update(params, managed_conn)
        
        except NotFoundError:
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"Update failed: {str(e)}", cause=e)

    async def update(self, params: UpdateParams) -> Dict[str, Any]:
        return await self._update(params)

    async def _delete(self, params: DeleteParams, connection=None) -> None:
        """Delete a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)

            conn = connection
            if conn is not None:
                result = conn.execute(delete(table).where(where_clause))
                if result.rowcount == 0:
                    raise NotFoundError(f"Record not found for deletion")

            else:
                with self.engine.begin() as managed_conn:
                    await self._delete(params, managed_conn)
        
        except NotFoundError:
            raise
        except Exception as e:
            raise QueryFailedError(f"Delete failed: {str(e)}", cause=e)

    async def delete(self, params: DeleteParams) -> None:
        await self._delete(params)

    async def create_many(self, params: CreateManyParams) -> List[Dict[str, Any]]:
        """Create multiple records."""
        try:
            table = self._get_table(params.model, params.namespace)
            
            with self.engine.begin() as conn:
                conn.execute(insert(table).values(params.data))
                return list(params.data)
        
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"CreateMany failed: {str(e)}", cause=e)

    async def update_many(self, params: UpdateManyParams) -> int:
        """Update multiple records."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)
            
            with self.engine.begin() as conn:
                result = conn.execute(update(table).where(where_clause).values(**params.data))
                return result.rowcount
        
        except Exception as e:
            raise QueryFailedError(f"UpdateMany failed: {str(e)}", cause=e)

    async def delete_many(self, params: DeleteManyParams) -> int:
        """Delete multiple records."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)
            
            with self.engine.begin() as conn:
                result = conn.execute(delete(table).where(where_clause))
                return result.rowcount
        
        except Exception as e:
            raise QueryFailedError(f"DeleteMany failed: {str(e)}", cause=e)

    async def upsert(self, params: UpsertParams) -> Dict[str, Any]:
        """Upsert a record."""
        # Try to find existing record
        existing = await self.find_one(
            FindOneParams(model=params.model, where=params.where, namespace=params.namespace)
        )
        
        if existing:
            return await self.update(
                UpdateParams(
                    model=params.model,
                    where=params.where,
                    data=params.update,
                    namespace=params.namespace,
                )
            )
        else:
            return await self.create(
                CreateParams(model=params.model, data=params.create, namespace=params.namespace)
            )

    async def count(self, params: CountParams) -> int:
        """Count records."""
        try:
            table = self._get_table(params.model, params.namespace)
            query = select(func.count()).select_from(table)
            
            if params.where:
                where_clause = self._build_where_clause(table, params.where)
                query = query.where(where_clause)
            
            with self.engine.connect() as conn:
                result = conn.execute(query)
                return result.scalar() or 0
        
        except Exception as e:
            raise QueryFailedError(f"Count failed: {str(e)}", cause=e)

    async def transaction(self, callback: Callable) -> Any:
        """Execute operations within a transaction."""
        with self.engine.begin() as conn:
            # Create transaction adapter
            trx_adapter = SQLAlchemyTransactionAdapter(conn, self)
            return await callback(trx_adapter)

    async def initialize(self) -> None:
        """Initialize the adapter."""
        # Test connection
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception as e:
            raise ConnectionError(f"Failed to initialize: {str(e)}", cause=e)

    async def is_healthy(self) -> HealthStatus:
        """Check adapter health."""
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            
            return HealthStatus(
                healthy=True,
                uptime=int(time.time() - self._start_time),
            )
        except Exception as e:
            return HealthStatus(
                healthy=False,
                last_error=str(e),
                uptime=int(time.time() - self._start_time),
            )

    async def close(self) -> None:
        """Close the adapter."""
        self.engine.dispose()

    async def get_schema_version(self, namespace: str) -> int:
        """Get the current schema version."""
        return 0  # TODO: Implement schema versioning

    async def set_schema_version(self, namespace: str, version: int) -> None:
        """Set the schema version."""
        pass  # TODO: Implement schema versioning

    async def validate_schema(self, schema: TableSchema) -> ValidationResult:
        """Validate a schema."""
        return ValidationResult(valid=True)  # TODO: Implement validation

    async def create_schema(self, params: CreateSchemaParams) -> SchemaCreation:
        """Create database schema."""
        return SchemaCreation(success=False, errors=["Schema creation not yet implemented"])


class SQLAlchemyTransactionAdapter:
    """Transaction adapter for SQLAlchemy."""

    def __init__(self, connection, parent_adapter: SQLAlchemyAdapter):
        self.connection = connection
        self.parent = parent_adapter

    async def commit(self) -> None:
        """Commit handled by context manager."""
        pass

    async def rollback(self) -> None:
        """Rollback the transaction."""
        self.connection.rollback()

    async def create(self, params: CreateParams) -> Dict[str, Any]:
        return await self.parent._create(params, self.connection)

    async def find_one(self, params: FindOneParams) -> Optional[Dict[str, Any]]:
        return await self.parent._find_one(params, self.connection)

    async def find_many(self, params: FindManyParams) -> List[Dict[str, Any]]:
        return await self.parent._find_many(params, self.connection)

    async def update(self, params: UpdateParams) -> Dict[str, Any]:
        return await self.parent._update(params, self.connection)

    async def delete(self, params: DeleteParams) -> None:
        await self.parent._delete(params, self.connection)


def create_adapter(engine: Engine, namespace_prefix: str = "") -> Adapter:
    """
    Create a SQLAlchemy adapter.
    
    Args:
        engine: SQLAlchemy Engine
        namespace_prefix: Optional prefix for table names
    
    Returns:
        SQLAlchemy adapter instance
    
    Example:
        >>> from sqlalchemy import create_engine
        >>> from superfunctions_sqlalchemy import create_adapter
        >>> 
        >>> engine = create_engine("postgresql://localhost/mydb")
        >>> adapter = create_adapter(engine)
    """
    return SQLAlchemyAdapter(engine, namespace_prefix)
