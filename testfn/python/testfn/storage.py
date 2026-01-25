import json
import time
from typing import List, Optional, Any
from sqlalchemy import create_engine, Column, String, Float, Integer, Text, JSON, ForeignKey, select
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from .types import TestRun, TestResult, Artifact, TestRunSummary, EnvironmentInfo, ResultStatus, TestError

Base = declarative_base()

class TestRunModel(Base):
    __tablename__ = "testfn_runs"
    id = Column(String, primary_key=True)
    timestamp = Column(Float, nullable=False)
    branch = Column(String)
    commit = Column(String)
    author = Column(String)
    environment = Column(JSON)
    summary = Column(JSON)
    results = relationship("TestResultModel", back_populates="run", cascade="all, delete-orphan")

class TestResultModel(Base):
    __tablename__ = "testfn_results"
    id = Column(String, primary_key=True)
    run_id = Column(String, ForeignKey("testfn_runs.id"), primary_key=True)
    status = Column(String, nullable=False)
    duration = Column(Float, nullable=False)
    error = Column(JSON)
    metadata_json = Column("metadata", JSON)
    run = relationship("TestRunModel", back_populates="results")
    artifacts = relationship("ArtifactModel", back_populates="result", cascade="all, delete-orphan")

class ArtifactModel(Base):
    __tablename__ = "testfn_artifacts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String)
    result_id = Column(String)
    artifact_id = Column(String, ForeignKey("testfn_results.id")) # result_id
    type = Column(String, nullable=False)
    path = Column(String, nullable=False)
    metadata_json = Column("metadata", JSON)
    result = relationship("TestResultModel", back_populates="artifacts")

class Storage:
    def __init__(self, database_url: str = "sqlite:///testfn.db"):
        self.engine = create_engine(database_url)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

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
        with self.Session() as session:
            stmt = select(TestRunModel).order_by(TestRunModel.timestamp.desc()).limit(limit)
            run_models = session.execute(stmt).scalars().all()
            return [self.get_run(m.id) for m in run_models] # type: ignore

    def get_test_history(self, test_id: str, limit: int = 10) -> List[TestResult]:
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
