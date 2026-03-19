#!/bin/bash
# Performance Calibration Script
# Orchestrates calibration benchmarks across local and Docker environments

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
RESULTS_DIR="./calibration-results"
COMPOSE_FILE="docker/docker-compose.calibration.yml"

# Functions
log_info() {
    echo -e "${BLUE}ℹ ${1}${NC}"
}

log_success() {
    echo -e "${GREEN}✓ ${1}${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠ ${1}${NC}"
}

log_error() {
    echo -e "${RED}✗ ${1}${NC}"
}

# Check Docker availability
check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed or not in PATH"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running"
        exit 1
    fi

    log_success "Docker is available"
}

# Build calibration images
build_images() {
    log_info "Building calibration Docker images..."
    docker compose -f "${COMPOSE_FILE}" build
    log_success "Images built successfully"
}

# Run local calibration (unconstrained)
run_local() {
    log_info "Running local calibration (unconstrained)..."

    mkdir -p "${RESULTS_DIR}"

    # Run directly using tsx for TypeScript execution
    npx tsx tests/calibration/run-local.ts

    log_success "Local calibration complete"
    log_info "Results saved to: ${RESULTS_DIR}/local-results.json"
}

# Run CI-simulated calibration in Docker
run_docker() {
    local platform="${1:-ubuntu}"

    log_info "Running CI simulation calibration (${platform})..."

    mkdir -p "${RESULTS_DIR}"

    # Build images if needed
    if ! docker images | grep -q "dollhousemcp:calibration-ci-${platform}"; then
        build_images
    fi

    # Run in Docker with resource constraints
    docker compose -f "${COMPOSE_FILE}" run --rm "calibration-ci-${platform}"

    log_success "CI simulation calibration complete"
    log_info "Results saved to: ${RESULTS_DIR}/ci-ubuntu-results.json"
}

# Run comparison between local and CI
run_comparison() {
    log_info "Running calibration comparison..."

    # Check if we have both results
    if [[ ! -f "${RESULTS_DIR}/local-results.json" ]]; then
        log_warning "Local calibration results not found. Running local calibration..."
        run_local
    fi

    if [[ ! -f "${RESULTS_DIR}/ci-ubuntu-results.json" ]]; then
        log_warning "CI simulation results not found. Running CI calibration..."
        run_docker ubuntu
    fi

    # Run comparison using tsx
    npx tsx tests/calibration/compare-results.ts

    log_success "Comparison complete"
    log_info "Report: ${RESULTS_DIR}/comparison.json"

    # Display summary
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 CALIBRATION SUMMARY"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Extract key metrics from JSON comparison
    if [[ -f "${RESULTS_DIR}/comparison.json" ]]; then
        echo "Results comparison saved to ${RESULTS_DIR}/comparison.json"
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    log_info "View full report: ${RESULTS_DIR}/comparison.json"
}

# Clean up calibration results
clean() {
    log_info "Cleaning calibration results..."
    if [[ -d "${RESULTS_DIR}" ]]; then
        rm -rf "${RESULTS_DIR}"
        log_success "Results cleaned"
    else
        log_info "No results directory to clean"
    fi
}

# Show usage
usage() {
    cat << EOF
Usage: $0 <command> [options]

Commands:
    local       Run calibration on local machine (unconstrained)
    docker      Run calibration in Docker CI simulation (default: ubuntu)
    compare     Run both and compare results
    build       Build Docker images
    clean       Remove calibration results
    help        Show this help message

Options:
    --platform=<platform>   Specify CI platform (ubuntu, macos, windows)
                           Only applicable for 'docker' command

Examples:
    $0 local                    # Run local calibration
    $0 docker                   # Run CI simulation (ubuntu)
    $0 docker --platform=macos  # Run CI simulation (macOS approximation)
    $0 compare                  # Run both and compare

Workflow:
    1. Run '$0 compare' to establish baseline calibration
    2. Use the ratios to predict CI performance from local benchmarks
    3. Re-run periodically to keep calibration accurate

EOF
}

# Main script logic
main() {
    local command="${1:-help}"
    shift || true

    # Parse options
    local platform="ubuntu"
    for arg in "$@"; do
        case $arg in
            --platform=*)
                platform="${arg#*=}"
                ;;
            *)
                ;;
        esac
    done

    case "$command" in
        local)
            run_local
            ;;
        docker)
            check_docker
            run_docker "$platform"
            ;;
        compare)
            check_docker
            run_comparison
            ;;
        build)
            check_docker
            build_images
            ;;
        clean)
            clean
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $command"
            echo ""
            usage
            exit 1
            ;;
    esac
}

# Run main
main "$@"
