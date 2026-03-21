import { ui } from "../src/ui.js";

describe("ui", () => {
  it("renders status messages without throwing", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    ui.success("ok");
    ui.warn("warn");
    ui.info("info");
    ui.error("error");
    ui.table([
      { name: "spec", status: "active" },
      { name: "phase", status: "pending" },
    ]);

    const spinner = ui.spinner("loading");
    spinner.start();
    spinner.succeed("done");

    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
