from typing import Any, List, Optional

from sqlalchemy import (
    JSON,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    create_engine,
    select,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)

from .types import (
    Artifact,
    EnvironmentInfo,
    ResultStatus,
    TestError,
    TestResult,
    TestRun,
    TestRunSummary,
)


class Base(DeclarativeBase):
    pass


class TestRunModel(Base):
    __tablename__ = "testfn_runs"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    timestamp: Mapped[float] = mapped_column(Float)
    branch: Mapped[Optional[str]] = mapped_column(String)
    commit: Mapped[Optional[str]] = mapped_column(String)
    author: Mapped[Optional[str]] = mapped_column(String)
    environment: Mapped[dict[str, Any]] = mapped_column(JSON)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON)
    results: Mapped[List["TestResultModel"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class TestResultModel(Base):
    __tablename__ = "testfn_results"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("testfn_runs.id"), primary_key=True)
    status: Mapped[str] = mapped_column(String)
    duration: Mapped[float] = mapped_column(Float)
    error: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON)
    run: Mapped[TestRunModel] = relationship(back_populates="results")
    artifacts: Mapped[List["ArtifactModel"]] = relationship(
        back_populates="result", cascade="all, delete-orphan"
    )


class ArtifactModel(Base):
    __tablename__ = "testfn_artifacts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String)
    result_id: Mapped[str] = mapped_column(String)
    __table_args__ = (
        ForeignKeyConstraint(
            ["result_id", "run_id"], ["testfn_results.id", "testfn_results.run_id"]
        ),
    )
    type: Mapped[str] = mapped_column(String)
    path: Mapped[str] = mapped_column(String)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON)
    result: Mapped[TestResultModel] = relationship(back_populates="artifacts")


class Storage:
    def __init__(self, database_url: str = "sqlite:///testfn.db"):
        self.engine = create_engine(database_url)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def close(self) -> None:
        self.engine.dispose()

    def save_run(self, run: TestRun) -> None:
        with self.Session() as session:
            run_model = TestRunModel(
                id=run.id,
                timestamp=run.timestamp,
                branch=run.branch,
                commit=run.commit,
                author=run.author,
                environment=run.environment.model_dump(),
                summary=run.summary.model_dump(),
            )
            session.add(run_model)

            for result in run.results:
                result_model = TestResultModel(
                    id=result.id,
                    run_id=run.id,
                    status=result.status.value,
                    duration=result.duration,
                    error=result.error.model_dump() if result.error else None,
                    metadata_json=result.metadata,
                )
                session.add(result_model)

                for artifact in result.artifacts:
                    artifact_model = ArtifactModel(
                        run_id=run.id,
                        result_id=result.id,
                        type=artifact.type,
                        path=artifact.path,
                        metadata_json=artifact.metadata,
                    )
                    result_model.artifacts.append(artifact_model)

            session.commit()

    def get_run(self, run_id: str) -> Optional[TestRun]:
        with self.Session() as session:
            stmt = select(TestRunModel).where(TestRunModel.id == run_id)
            run_model = session.execute(stmt).scalar_one_or_none()
            if not run_model:
                return None

            results = []
            for r in run_model.results:
                artifacts = [
                    Artifact(type=a.type, path=a.path, metadata=a.metadata_json)
                    for a in r.artifacts
                ]
                results.append(
                    TestResult(
                        id=r.id,
                        status=ResultStatus(r.status),
                        duration=r.duration,
                        error=TestError(**r.error) if r.error else None,
                        artifacts=artifacts,
                        metadata=r.metadata_json or {},
                    )
                )

            return TestRun(
                id=run_model.id,
                timestamp=run_model.timestamp,
                branch=run_model.branch,
                commit=run_model.commit,
                author=run_model.author,
                environment=EnvironmentInfo(**run_model.environment),
                summary=TestRunSummary(**run_model.summary),
                results=results,
            )

    def get_recent_runs(self, limit: int = 10) -> List[TestRun]:
        if not isinstance(limit, int) or limit < 0:
            raise ValueError("limit must be a nonnegative integer")
        with self.Session() as session:
            stmt = (
                select(TestRunModel)
                .order_by(TestRunModel.timestamp.desc())
                .limit(limit)
            )
            run_models = session.execute(stmt).scalars().all()
            return [run for m in run_models if (run := self.get_run(m.id)) is not None]

    def get_test_history(self, test_id: str, limit: int = 10) -> List[TestResult]:
        if not isinstance(limit, int) or limit < 0:
            raise ValueError("limit must be a nonnegative integer")
        with self.Session() as session:
            stmt = (
                select(TestResultModel)
                .where(TestResultModel.id == test_id)
                .join(TestRunModel)
                .order_by(TestRunModel.timestamp.desc())
                .limit(limit)
            )
            result_models = session.execute(stmt).scalars().all()

            results = []
            for r in result_models:
                artifacts = [
                    Artifact(type=a.type, path=a.path, metadata=a.metadata_json)
                    for a in r.artifacts
                ]
                results.append(
                    TestResult(
                        id=r.id,
                        status=ResultStatus(r.status),
                        duration=r.duration,
                        error=TestError(**r.error) if r.error else None,
                        artifacts=artifacts,
                        metadata=r.metadata_json or {},
                    )
                )
            return results
