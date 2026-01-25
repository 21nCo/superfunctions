.PHONY: install test lint format typecheck clean build publish

install:
	pip install -e ".[dev]"

test:
	pytest -v

test-cov:
	pytest --cov=cachefn --cov-report=html --cov-report=term

lint:
	ruff check cachefn tests examples

format:
	black cachefn tests examples
	ruff check --fix cachefn tests examples

typecheck:
	mypy cachefn

clean:
	rm -rf build dist *.egg-info
	rm -rf .pytest_cache .mypy_cache .ruff_cache
	rm -rf htmlcov .coverage
	find . -type d -name __pycache__ -exec rm -rf {} +

build: clean
	python -m build

publish: build
	python -m twine upload dist/*

dev:
	pip install -e ".[dev,fastapi,flask]"
