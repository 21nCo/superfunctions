"""Plugin-free typed constructors and wire validation for an installed wheel."""
from cifn import (
    CreateRunResult,
    JobSpec,
    PipelineRef,
    RunStatus,
    RunStep,
    StepUsesType,
    UsesStep,
)


def main() -> None:
    reference = PipelineRef(repo="example/project", ref="main")
    assert reference.config_path is None
    reference_with_path = PipelineRef(repo="example/project", ref="main", config_path="ci.yml")
    assert reference_with_path.model_dump(by_alias=True)["configPath"] == "ci.yml"
    step = RunStep(run="echo test")
    assert step.if_condition is None
    conditional = RunStep(run="echo test", if_condition="success()")
    checkout = UsesStep(uses=StepUsesType.CHECKOUT, with_params={"depth": 1})
    job = JobSpec(runs_on="default", steps=[conditional, checkout])
    assert job.model_dump(by_alias=True, exclude_none=True) == {
        "runs-on": "default",
        "steps": [{"run": "echo test", "if": "success()"},
                  {"uses": StepUsesType.CHECKOUT, "with": {"depth": 1}}],
    }
    constructed = CreateRunResult(
        run_id="r1", status=RunStatus.QUEUED, created_at="2026-01-01T00:00:00Z"
    )
    validated = CreateRunResult.model_validate({
        "runId": "r1", "status": "queued", "createdAt": "2026-01-01T00:00:00Z",
    })
    assert constructed == validated
    assert constructed.model_dump(mode="json", by_alias=True) == {
        "runId": "r1", "status": "queued", "createdAt": "2026-01-01T00:00:00Z",
    }


if __name__ == "__main__":
    main()
