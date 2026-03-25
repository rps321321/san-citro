.PHONY: all test lint typecheck format install clean

# Default target runs the full CI suite
all: lint typecheck test

# Install all development dependencies
install:
	python -m pip install --upgrade pip
	pip install -r requirements-dev.txt

# Run the test suite with coverage reporting
test:
	pytest --cov=src --cov-report=term-missing -v

# Run ruff linter and formatter check
lint:
	ruff check src/ tests/
	ruff format --check src/ tests/

# Run mypy type checking on source code
typecheck:
	mypy src/

# Auto-fix lint issues and reformat code
format:
	ruff check --fix src/ tests/
	ruff format src/ tests/

# Remove build artifacts and caches
clean:
	rm -rf __pycache__ src/__pycache__ tests/__pycache__
	rm -rf .pytest_cache .mypy_cache .ruff_cache
	rm -rf *.egg-info dist build
	rm -rf htmlcov coverage.xml .coverage
