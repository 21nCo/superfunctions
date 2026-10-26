# TestFn Python readiness checkpoint — 2026-10-16

Prepared testfn0.0.2; live PyPI0.0.1 owned21n confirmed https://pypi.org/pypi/testfn/json. Nothing published.

Implemented exact pytest nodeids and phase status via packaged plugin; default suite fixture scope preserved; explicit parallel/retry/timeout options isolate attempts. Env applies to discovery/execution; timeout and cancellation reap subprocesses (POSIX processgroup). Collection/protocol failures cannot become empty success. Default callbacks stream after teardown; final callback delivery deduplicated. Atomic JSON reports, timeout failure accounting, nearest-rank p95 and missing-run errors. Composite run/test artifact relation fixes cross-run mixing. RGBA visual score retainsRGBmeaning, validatesnames/thresholds,atomic baseline nooverwrite andvisiblealpha diff. TypedSQLAlchemy models,py.typed,MITlicense and wheel script.

18tests pass Python3.12.12 and3.10.19. Strictmypy10sourcefiles and Ruff pass. Fresh installedwheel consumers onbothversions validate actualpytest,class/parameterids,SQLiteclose/reopen,JSONreport andpy.typed. Exactminimum-runtime consumer Python3.10,pytest9.0.3,Pydantic2.5.0,SQLAlchemy2.0.0,Pillow12.3.0 passes. Installedlatest andresolvedminimumdependencygraphs pip-audit report zero known vulnerabilities (localtestfnwheel skipped as localURL). Oldpytest7.4 andPillow10floors had advisories; floors now9.0.3/12.3.0. Finalwheel/sdist0.0.2 built.

Initial parallel Pythonmatrix exposed preexisting fixed-filename fixtures racing (SQLite/imagepaths); tests nowuseindependent tmp_path. One3.10 streamtest saw previousinstalledpluginwhile sourceupdated; after finalwheel reinstall,all18pass. Finalversionmetadata acceptance runs0.0.2 separately.

Explicit boundaries: defaultonepytestsession; isolatedoptions repeatmodule/sessionfixtures. Collectiondeadline60s; zero matchedtests reportedzero notpassassertion. Pytestaddoptsdisabled. Windows grandchildren cleanupnotproven; POSIXactualcancel tested. LegacySQLite retainsnullableartifact_id untilhostconstraintmigration; ORM reads/writes usecorrectcompositekeys. No blanket TestFn originalTSV0completionclaim.
