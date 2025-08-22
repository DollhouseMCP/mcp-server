#!/usr/bin/env node

/**
 * QA Dashboard Generator
 * Generates markdown dashboard with QA metrics trends and statistics
 * 
 * Part of DollhouseMCP QA Metrics System
 * Reads metrics from docs/QA/metrics/ directory and creates dashboard
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DashboardGenerator {
    constructor() {
        this.metricsDir = path.join(__dirname, '..', 'docs', 'QA', 'metrics');
        this.dashboardPath = path.join(__dirname, '..', 'docs', 'QA', 'METRICS_DASHBOARD.md');
        this.maxHistoryItems = 10; // Show last 10 PRs/runs
    }

    /**
     * Main entry point for dashboard generation
     */
    async generateDashboard() {
        try {
            console.log('🔄 Generating QA Metrics Dashboard...');
            
            const metrics = await this.loadMetrics();
            if (metrics.length === 0) {
                console.log('⚠️  No metrics found. Creating placeholder dashboard.');
                await this.createPlaceholderDashboard();
                return;
            }

            const analysis = await this.analyzeMetrics(metrics);
            const dashboardContent = await this.generateDashboardMarkdown(analysis);
            
            await fs.writeFile(this.dashboardPath, dashboardContent);
            console.log('✅ Dashboard generated successfully:', this.dashboardPath);
            
            // Show quick summary
            this.printSummary(analysis);
            
        } catch (error) {
            console.error('❌ Failed to generate dashboard:', error.message);
            throw error;
        }
    }

    /**
     * Load all metrics files from the metrics directory
     */
    async loadMetrics() {
        try {
            const files = await fs.readdir(this.metricsDir);
            const metricsFiles = files
                .filter(file => file.endsWith('.json') && file.startsWith('qa-metrics-'))
                .sort((a, b) => b.localeCompare(a)); // Sort newest first

            const metrics = [];
            for (const file of metricsFiles) {
                try {
                    const filePath = path.join(this.metricsDir, file);
                    const content = await fs.readFile(filePath, 'utf8');
                    const data = JSON.parse(content);
                    data._filename = file;
                    metrics.push(data);
                } catch (error) {
                    console.warn(`⚠️  Failed to parse ${file}:`, error.message);
                }
            }

            console.log(`📊 Loaded ${metrics.length} metrics files`);
            return metrics.slice(0, this.maxHistoryItems); // Limit to recent history
        } catch (error) {
            console.warn('⚠️  Metrics directory not found or empty:', error.message);
            return [];
        }
    }

    /**
     * Analyze metrics to extract trends and insights
     */
    async analyzeMetrics(metrics) {
        const latest = metrics[0];
        const historical = metrics.slice(1);

        const analysis = {
            latest: this.extractLatestMetrics(latest),
            trends: this.calculateTrends(metrics),
            alerts: this.generateAlerts(metrics),
            historical: historical.map(m => this.extractSummary(m))
        };

        return analysis;
    }

    /**
     * Extract key metrics from the latest run
     */
    extractLatestMetrics(metrics) {
        return {
            timestamp: metrics.timestamp,
            test_run_id: metrics.test_run_id,
            pr_number: metrics.pr_number || 'N/A',
            branch: metrics.branch || 'local',
            success_rate: metrics.success_metrics.success_rate,
            tools_available: metrics.success_metrics.tools_available,
            total_tests: metrics.success_metrics.total_tests,
            successful_tests: metrics.success_metrics.successful_tests,
            failed_tests: metrics.success_metrics.failed_tests,
            skipped_tests: metrics.success_metrics.skipped_tests,
            avg_response_time: Math.round(metrics.performance.percentiles.avg),
            p95_response_time: metrics.performance.percentiles.p95,
            total_duration: metrics.performance.total_duration_ms,
            server_startup_time: metrics.performance.server_startup_ms,
            peak_memory: Math.round(metrics.performance.memory_usage.peak_rss / 1024 / 1024), // MB
            environment: metrics.environment,
            insights: metrics.insights || []
        };
    }

    /**
     * Extract summary metrics for historical comparison
     */
    extractSummary(metrics) {
        const timestamp = new Date(metrics.timestamp);
        return {
            date: timestamp.toISOString().split('T')[0],
            time: timestamp.toISOString().split('T')[1].split('.')[0],
            pr_number: metrics.pr_number || 'local',
            branch: metrics.branch || 'local',
            success_rate: metrics.success_metrics.success_rate,
            tools_available: metrics.success_metrics.tools_available,
            avg_response_time: Math.round(metrics.performance.percentiles.avg),
            p95_response_time: metrics.performance.percentiles.p95,
            total_tests: metrics.success_metrics.total_tests,
            failed_tests: metrics.success_metrics.failed_tests,
            peak_memory_mb: Math.round(metrics.performance.memory_usage.peak_rss / 1024 / 1024)
        };
    }

    /**
     * Calculate trends over time
     */
    calculateTrends(metrics) {
        if (metrics.length < 2) {
            return {
                success_rate: { trend: 'stable', change: 0 },
                response_time: { trend: 'stable', change: 0 },
                memory_usage: { trend: 'stable', change: 0 },
                test_count: { trend: 'stable', change: 0 }
            };
        }

        const latest = metrics[0];
        const previous = metrics[1];

        return {
            success_rate: this.calculateTrend(
                latest.success_metrics.success_rate,
                previous.success_metrics.success_rate,
                'percentage'
            ),
            response_time: this.calculateTrend(
                latest.performance.percentiles.avg,
                previous.performance.percentiles.avg,
                'milliseconds'
            ),
            memory_usage: this.calculateTrend(
                latest.performance.memory_usage.peak_rss,
                previous.performance.memory_usage.peak_rss,
                'bytes'
            ),
            test_count: this.calculateTrend(
                latest.success_metrics.total_tests,
                previous.success_metrics.total_tests,
                'count'
            )
        };
    }

    /**
     * Calculate trend direction and magnitude
     */
    calculateTrend(current, previous, unit) {
        const change = current - previous;
        const percentChange = previous === 0 ? 0 : (change / previous) * 100;
        
        let trend = 'stable';
        if (Math.abs(percentChange) > 5) { // 5% threshold for significance
            trend = change > 0 ? 'increasing' : 'decreasing';
        }

        let displayChange = change;
        if (unit === 'bytes') {
            displayChange = Math.round(change / 1024 / 1024); // Convert to MB
        }

        return {
            trend,
            change: displayChange,
            percentChange: Math.round(percentChange),
            unit
        };
    }

    /**
     * Generate performance and reliability alerts
     */
    generateAlerts(metrics) {
        const alerts = [];
        const latest = metrics[0];

        // Success rate alerts
        if (latest.success_metrics.success_rate < 50) {
            alerts.push({
                type: 'error',
                severity: 'high',
                message: `Critical: Success rate is ${latest.success_metrics.success_rate}%`,
                recommendation: 'Immediate investigation required - majority of tests failing'
            });
        } else if (latest.success_metrics.success_rate < 80) {
            alerts.push({
                type: 'warning',
                severity: 'medium',
                message: `Success rate is ${latest.success_metrics.success_rate}%`,
                recommendation: 'Monitor test failures and investigate recurring issues'
            });
        }

        // Performance alerts
        if (latest.performance.percentiles.p95 > 1000) { // > 1 second
            alerts.push({
                type: 'warning',
                severity: 'medium',
                message: `High P95 response time: ${latest.performance.percentiles.p95}ms`,
                recommendation: 'Performance degradation detected - review slow operations'
            });
        }

        // Memory usage alerts
        const memoryMB = latest.performance.memory_usage.peak_rss / 1024 / 1024;
        if (memoryMB > 100) { // > 100MB
            alerts.push({
                type: 'info',
                severity: 'low',
                message: `High memory usage: ${Math.round(memoryMB)}MB`,
                recommendation: 'Monitor for memory leaks in long-running tests'
            });
        }

        // Trend alerts
        if (metrics.length >= 2) {
            const trends = this.calculateTrends(metrics);
            
            if (trends.success_rate.trend === 'decreasing' && Math.abs(trends.success_rate.percentChange) > 10) {
                alerts.push({
                    type: 'warning',
                    severity: 'medium',
                    message: `Success rate declining: ${trends.success_rate.percentChange}% decrease`,
                    recommendation: 'Investigate recent changes causing test failures'
                });
            }

            if (trends.response_time.trend === 'increasing' && trends.response_time.percentChange > 20) {
                alerts.push({
                    type: 'warning',
                    severity: 'medium',
                    message: `Response time increasing: ${trends.response_time.percentChange}% slower`,
                    recommendation: 'Performance regression detected - review recent changes'
                });
            }
        }

        return alerts;
    }

    /**
     * Generate the full dashboard markdown content
     */
    async generateDashboardMarkdown(analysis) {
        const { latest, trends, alerts, historical } = analysis;
        const timestamp = new Date().toISOString();

        let content = `# QA Metrics Dashboard

**Generated**: ${timestamp}  
**Data Points**: ${historical.length + 1} test runs  
**Latest Run**: ${latest.timestamp}

## 🔍 Latest Results

### Summary
- **PR/Branch**: ${latest.pr_number} (${latest.branch})
- **Success Rate**: ${latest.success_rate}% (${latest.successful_tests}/${latest.total_tests})
- **Tools Available**: ${latest.tools_available}
- **Failed Tests**: ${latest.failed_tests}
- **Skipped Tests**: ${latest.skipped_tests}

### Performance
- **Average Response Time**: ${latest.avg_response_time}ms
- **95th Percentile**: ${latest.p95_response_time}ms
- **Total Test Duration**: ${latest.total_duration}ms
- **Server Startup Time**: ${latest.server_startup_time}ms
- **Peak Memory Usage**: ${latest.peak_memory}MB

### Environment
- **CI**: ${latest.environment.ci ? 'Yes' : 'Local'}
- **Node Version**: ${latest.environment.node_version}
- **Platform**: ${latest.environment.platform}

`;

        // Add alerts section
        if (alerts.length > 0) {
            content += `## 🚨 Alerts

`;
            for (const alert of alerts) {
                const emoji = alert.type === 'error' ? '🔴' : alert.type === 'warning' ? '⚠️' : 'ℹ️';
                content += `### ${emoji} ${alert.message}
**Severity**: ${alert.severity}  
**Recommendation**: ${alert.recommendation}

`;
            }
        }

        // Add trends section
        content += `## 📈 Trends

`;
        if (historical.length > 0) {
            content += this.generateTrendsSection(trends);
        } else {
            content += `*Not enough data for trend analysis. Need at least 2 test runs.*

`;
        }

        // Add historical data table
        content += `## 📊 Historical Data (Last ${historical.length + 1} Runs)

| Date | Time | PR/Branch | Success Rate | Tools | Avg Time | P95 Time | Tests | Failed | Memory |
|------|------|-----------|-------------|-------|----------|----------|-------|---------|---------|
`;

        // Add latest run first
        const latestDate = new Date(latest.timestamp).toISOString().split('T')[0];
        const latestTime = new Date(latest.timestamp).toISOString().split('T')[1].split('.')[0];
        content += `| ${latestDate} | ${latestTime} | ${latest.pr_number}/${latest.branch} | ${latest.success_rate}% | ${latest.tools_available} | ${latest.avg_response_time}ms | ${latest.p95_response_time}ms | ${latest.total_tests} | ${latest.failed_tests} | ${latest.peak_memory}MB |\n`;

        // Add historical runs
        for (const run of historical) {
            content += `| ${run.date} | ${run.time} | ${run.pr_number}/${run.branch} | ${run.success_rate}% | ${run.tools_available} | ${run.avg_response_time}ms | ${run.p95_response_time}ms | ${run.total_tests} | ${run.failed_tests} | ${run.peak_memory_mb}MB |\n`;
        }

        content += `
`;

        // Add ASCII charts
        content += this.generatePerformanceCharts(analysis);

        // Add insights section
        if (latest.insights && latest.insights.length > 0) {
            content += `## 💡 Latest Insights

`;
            for (const insight of latest.insights) {
                content += `- **${insight.type}** (${insight.severity}): ${insight.message}
  - *${insight.recommendation}*
`;
            }
            content += `
`;
        }

        // Add footer
        content += `## 🔧 Usage

This dashboard is automatically generated by \`scripts/qa-dashboard-generator.js\`.

### Commands
\`\`\`bash
# Generate dashboard manually
node scripts/qa-dashboard-generator.js

# Run QA tests (will update metrics)
npm run qa:test

# View all metrics files
ls -la docs/QA/metrics/
\`\`\`

### Metrics Collection
Metrics are automatically collected during QA test runs and saved to \`docs/QA/metrics/\`. Each test run generates a timestamped JSON file with comprehensive performance and reliability data.

---
*Dashboard generated by DollhouseMCP QA Metrics System*
`;

        return content;
    }

    /**
     * Generate trends section with visual indicators
     */
    generateTrendsSection(trends) {
        const getTrendIcon = (trend) => {
            switch (trend) {
                case 'increasing': return '📈';
                case 'decreasing': return '📉';
                default: return '➖';
            }
        };

        const getChangeDescription = (trend) => {
            const icon = getTrendIcon(trend.trend);
            let description = `${icon} ${trend.trend}`;
            
            if (trend.trend !== 'stable') {
                if (trend.unit === 'bytes') {
                    description += ` (${trend.change}MB, ${trend.percentChange}%)`;
                } else if (trend.unit === 'percentage') {
                    description += ` (${trend.change}%, ${trend.percentChange}pp)`;
                } else {
                    description += ` (${trend.change}${trend.unit === 'milliseconds' ? 'ms' : ''}, ${trend.percentChange}%)`;
                }
            }
            
            return description;
        };

        return `| Metric | Trend | Description |
|--------|-------|-------------|
| Success Rate | ${getChangeDescription(trends.success_rate)} | Test pass rate over time |
| Response Time | ${getChangeDescription(trends.response_time)} | Average API response speed |
| Memory Usage | ${getChangeDescription(trends.memory_usage)} | Peak memory consumption |
| Test Count | ${getChangeDescription(trends.test_count)} | Number of tests executed |

`;
    }

    /**
     * Generate ASCII charts for performance visualization
     */
    generatePerformanceCharts(analysis) {
        if (analysis.historical.length === 0) {
            return `## 📊 Performance Charts

*Not enough data for charts. Need at least 2 test runs.*

`;
        }

        const allRuns = [analysis.latest, ...analysis.historical];
        
        let content = `## 📊 Performance Charts

### Success Rate Trend
\`\`\`
`;

        // Generate simple ASCII chart for success rates
        const maxRate = Math.max(...allRuns.map(r => r.success_rate));
        const chartWidth = 50;
        
        for (let i = 0; i < Math.min(allRuns.length, 10); i++) {
            const run = allRuns[i];
            const barLength = Math.round((run.success_rate / 100) * chartWidth);
            const bar = '█'.repeat(barLength) + '░'.repeat(chartWidth - barLength);
            const label = run.pr_number === 'local' ? 'local' : `PR${run.pr_number}`;
            content += `${label.padEnd(8)} │${bar}│ ${run.success_rate}%\n`;
        }
        
        content += `         └${'─'.repeat(chartWidth)}┘\n`;
        content += `          0%${' '.repeat(chartWidth - 6)}100%\n`;

        content += `\`\`\`

### Response Time Trend
\`\`\`
`;

        // Generate response time chart
        const maxTime = Math.max(...allRuns.map(r => r.avg_response_time));
        
        for (let i = 0; i < Math.min(allRuns.length, 10); i++) {
            const run = allRuns[i];
            const barLength = maxTime > 0 ? Math.round((run.avg_response_time / maxTime) * chartWidth) : 0;
            const bar = '█'.repeat(barLength) + '░'.repeat(chartWidth - barLength);
            const label = run.pr_number === 'local' ? 'local' : `PR${run.pr_number}`;
            content += `${label.padEnd(8)} │${bar}│ ${run.avg_response_time}ms\n`;
        }
        
        content += `         └${'─'.repeat(chartWidth)}┘\n`;
        content += `          0ms${' '.repeat(chartWidth - 9)}${maxTime}ms\n`;

        content += `\`\`\`

`;
        return content;
    }

    /**
     * Create a placeholder dashboard when no metrics exist
     */
    async createPlaceholderDashboard() {
        const content = `# QA Metrics Dashboard

**Status**: No metrics data available  
**Generated**: ${new Date().toISOString()}

## 🔍 Getting Started

This dashboard will show QA metrics trends once test runs are completed.

### To generate metrics:
\`\`\`bash
# Run QA tests to generate initial metrics
npm run build
node scripts/qa-test-runner.js

# Or run individual QA tests
node scripts/qa-simple-test.js
node scripts/qa-element-test.js
\`\`\`

### Expected metrics:
- **Success Rates**: Test pass/fail percentages
- **Performance**: Response times and percentiles
- **Memory Usage**: Peak memory consumption
- **Trends**: Historical comparison over time
- **Alerts**: Performance and reliability warnings

### Metrics Location
Metrics are saved to: \`docs/QA/metrics/qa-metrics-[timestamp].json\`

---
*Dashboard generated by DollhouseMCP QA Metrics System*
`;

        await fs.writeFile(this.dashboardPath, content);
        console.log('📝 Created placeholder dashboard');
    }

    /**
     * Print summary to console
     */
    printSummary(analysis) {
        console.log('\n📊 Dashboard Summary:');
        console.log(`   Success Rate: ${analysis.latest.success_rate}%`);
        console.log(`   Average Response Time: ${analysis.latest.avg_response_time}ms`);
        console.log(`   Total Tests: ${analysis.latest.total_tests}`);
        console.log(`   Failed Tests: ${analysis.latest.failed_tests}`);
        console.log(`   Tools Available: ${analysis.latest.tools_available}`);
        
        if (analysis.alerts.length > 0) {
            console.log(`\n⚠️  ${analysis.alerts.length} alert(s) generated`);
            for (const alert of analysis.alerts) {
                console.log(`   ${alert.type}: ${alert.message}`);
            }
        }
        
        console.log(`\n📈 View full dashboard: ${this.dashboardPath}`);
    }
}

// CLI execution
async function main() {
    try {
        const generator = new DashboardGenerator();
        await generator.generateDashboard();
        process.exit(0);
    } catch (error) {
        console.error('❌ Dashboard generation failed:', error.message);
        process.exit(1);
    }
}

// Only run if called directly (ES module check)
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default DashboardGenerator;