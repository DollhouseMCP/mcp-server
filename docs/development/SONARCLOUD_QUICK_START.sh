#!/bin/bash
# SonarCloud Reliability - Quick Start Script
# Copy and paste these commands to get started quickly

echo "🚀 SonarCloud Reliability Quick Start"
echo "======================================"
echo ""

echo "📍 Step 1: Verify Location"
pwd
# Should show: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server

echo ""
echo "📍 Step 2: Git Setup"
git checkout develop && git pull
git status

echo ""
echo "✅ Environment ready!"
echo ""
echo "📋 Next: Activate Dollhouse elements in Claude Code:"
echo ""
echo "COPY AND PASTE THESE INTO CLAUDE CODE:"
echo "======================================="
echo ""
echo "# Essential Personas"
echo "mcp__dollhousemcp-production__activate_element --name sonar-guardian --type personas"
echo "mcp__dollhousemcp-production__activate_element --name alex-sterling --type personas"
echo ""
echo "# Critical Memories"
echo "mcp__dollhousemcp-production__activate_element --name sonarcloud-query-procedure --type memories"
echo "mcp__dollhousemcp-production__activate_element --name sonarcloud-rules-reference --type memories"
echo "mcp__dollhousemcp-production__activate_element --name sonarcloud-api-reference --type memories"
echo "mcp__dollhousemcp-production__activate_element --name sonarcloud-reliability-session-prep --type memories"
echo ""
echo "# Automation Skill"
echo "mcp__dollhousemcp-production__activate_element --name sonarcloud-modernizer --type skills"
echo ""
echo "======================================="
echo ""
echo "📚 Documentation to Read:"
echo "  1. docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md (Complete roadmap)"
echo "  2. docs/development/SONARCLOUD_RELIABILITY_ONBOARDING.md (Setup guide)"
echo "  3. docs/development/SONARCLOUD_QUERY_PROCEDURE.md (CRITICAL!)"
echo ""
echo "🎯 First Task: Issue #1221 (10 min quick win)"
echo "   https://github.com/DollhouseMCP/mcp-server/issues/1221"
echo ""
echo "✨ You're ready to start!"
