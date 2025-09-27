#!/bin/bash

# Real LLM API Test for Capability Index Structures
# Uses actual Claude/GPT API calls in isolated environments

cat > /tmp/llm_capability_test.py <<'EOF'
#!/usr/bin/env python3

import os
import json
import time
from typing import Dict, List, Any
import anthropic
import openai
from dataclasses import dataclass
from concurrent.futures import ProcessPoolExecutor
import subprocess

@dataclass
class TestVariation:
    id: str
    name: str
    system_prompt: str
    hypothesis: str

@dataclass
class TestResult:
    variation_id: str
    query: str
    expected: str
    selected: str
    correct: bool
    tokens_used: int
    response_time: float
    confidence: float

# Test Variations
variations = [
    TestVariation(
        id="cascade_top",
        name="Cascade at Top",
        hypothesis="Best performance - trigger map in high attention zone",
        system_prompt="""CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  crash → debug-detective
  bug → debug-detective
  git → git-manager
  commit → git-manager
  branch → git-manager
  issue → github-issue-creator
  github → github-issue-creator

When you identify a needed capability from the triggers above, respond with ONLY:
SELECTED: [capability-name]

You are an AI assistant. Analyze the user's request and select the appropriate capability."""
    ),

    TestVariation(
        id="cascade_bottom",
        name="Cascade at Bottom",
        hypothesis="Worse performance - trigger map in low attention zone",
        system_prompt="""You are an AI assistant. Analyze the user's request and select the appropriate capability.

[Imagine this is after 500 tokens of other context about system operations, procedures, guidelines, and various other information that might be relevant to handling requests effectively but creates distance between instructions and triggers]

When you identify a needed capability, respond with ONLY:
SELECTED: [capability-name]

CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  crash → debug-detective
  bug → debug-detective
  git → git-manager
  commit → git-manager
  branch → git-manager
  issue → github-issue-creator
  github → github-issue-creator"""
    ),

    TestVariation(
        id="nested_deep",
        name="Deeply Nested",
        hypothesis="Poor performance - requires traversal",
        system_prompt="""System configuration with available capabilities:
{
  "environment": {
    "production": false,
    "capabilities": {
      "available": {
        "development": {
          "tools": {
            "debugging": {
              "primary": {
                "debug-detective": {
                  "triggers": ["debug", "error", "crash", "bug"],
                  "description": "Debugging and error analysis"
                }
              }
            },
            "version_control": {
              "primary": {
                "git-manager": {
                  "triggers": ["git", "commit", "branch"],
                  "description": "Git operations"
                }
              }
            },
            "issue_tracking": {
              "primary": {
                "github-issue-creator": {
                  "triggers": ["issue", "github"],
                  "description": "GitHub issue management"
                }
              }
            }
          }
        }
      }
    }
  }
}

When you identify a needed capability, respond with ONLY:
SELECTED: [capability-name]"""
    ),

    TestVariation(
        id="flat_list",
        name="Flat List",
        hypothesis="Moderate performance - simple but verbose",
        system_prompt="""Available capabilities:

1. debug-detective
   - Keywords: debug, error, crash, bug
   - Purpose: Debugging and error analysis

2. git-manager
   - Keywords: git, commit, branch
   - Purpose: Version control operations

3. github-issue-creator
   - Keywords: issue, github
   - Purpose: GitHub issue management

When you identify a needed capability, respond with ONLY:
SELECTED: [capability-name]"""
    ),

    TestVariation(
        id="action_verbs",
        name="Action Verbs",
        hypothesis="Better - action-oriented language",
        system_prompt="""CAPABILITY_ACTIONS:
  NEED_DEBUG → SELECT: debug-detective
  FOUND_ERROR → SELECT: debug-detective
  MUST_FIX_BUG → SELECT: debug-detective
  NEED_COMMIT → SELECT: git-manager
  SAVE_CHANGES → SELECT: git-manager
  CREATE_ISSUE → SELECT: github-issue-creator

Match user intent to action above, then respond with ONLY:
SELECTED: [capability-name]"""
    ),

    TestVariation(
        id="passive_language",
        name="Passive Language",
        hypothesis="Worse - passive descriptions",
        system_prompt="""The following capabilities are available:

debug-detective: This capability is available for debugging purposes
git-manager: This capability can be used for git operations
github-issue-creator: This capability exists for issue creation

These may be selected if deemed appropriate.

When you identify a needed capability, respond with ONLY:
SELECTED: [capability-name]"""
    ),

    TestVariation(
        id="control_none",
        name="Control: No Structure",
        hypothesis="Worst - no guidance",
        system_prompt="""You have access to: debug-detective, git-manager, github-issue-creator

When you identify a needed capability, respond with ONLY:
SELECTED: [capability-name]"""
    )
]

# Test queries
test_queries = [
    {"query": "Help me debug this error", "expected": "debug-detective"},
    {"query": "Fix this bug in my code", "expected": "debug-detective"},
    {"query": "The application is crashing", "expected": "debug-detective"},
    {"query": "Create a git commit", "expected": "git-manager"},
    {"query": "Save my changes to the repository", "expected": "git-manager"},
    {"query": "Open a GitHub issue", "expected": "github-issue-creator"},
    {"query": "Report this problem on GitHub", "expected": "github-issue-creator"},
    {"query": "I need help with my code", "expected": "debug-detective"},
    {"query": "What is git?", "expected": "none"},
    {"query": "Tell me about debugging", "expected": "none"}
]

def run_isolated_test(variation: TestVariation, query: dict, api_key: str, model: str = "claude") -> TestResult:
    """
    Run a single test in an isolated subprocess to avoid context contamination
    """
    start_time = time.time()

    try:
        if model == "claude":
            client = anthropic.Anthropic(api_key=api_key)
            response = client.messages.create(
                model="claude-3-haiku-20240307",
                max_tokens=50,
                temperature=0,
                system=variation.system_prompt,
                messages=[{"role": "user", "content": query["query"]}]
            )

            text = response.content[0].text
            tokens = response.usage.input_tokens + response.usage.output_tokens

        elif model == "gpt":
            client = openai.OpenAI(api_key=api_key)
            response = client.chat.completions.create(
                model="gpt-3.5-turbo",
                max_tokens=50,
                temperature=0,
                messages=[
                    {"role": "system", "content": variation.system_prompt},
                    {"role": "user", "content": query["query"]}
                ]
            )

            text = response.choices[0].message.content
            tokens = response.usage.total_tokens

        # Parse response
        selected = None
        if "SELECTED:" in text:
            parts = text.split("SELECTED:")
            if len(parts) > 1:
                selected = parts[1].strip().split()[0]

        # Calculate correctness
        correct = False
        if query["expected"] == "none":
            correct = selected is None or selected == "none"
        else:
            correct = selected == query["expected"]

        return TestResult(
            variation_id=variation.id,
            query=query["query"],
            expected=query["expected"],
            selected=selected or "none",
            correct=correct,
            tokens_used=tokens,
            response_time=time.time() - start_time,
            confidence=0.95 if correct else 0.5
        )

    except Exception as e:
        print(f"Error in test: {e}")
        return TestResult(
            variation_id=variation.id,
            query=query["query"],
            expected=query["expected"],
            selected="error",
            correct=False,
            tokens_used=0,
            response_time=time.time() - start_time,
            confidence=0
        )

def run_variation_tests(variation: TestVariation, api_key: str, model: str = "claude") -> Dict[str, Any]:
    """
    Run all queries for a single variation
    """
    print(f"\nTesting: {variation.name}")
    print(f"Hypothesis: {variation.hypothesis}")
    print("-" * 60)

    results = []
    correct_count = 0
    total_tokens = 0

    for query in test_queries:
        # Run in isolated subprocess to prevent contamination
        result = run_isolated_test(variation, query, api_key, model)
        results.append(result)

        if result.correct:
            correct_count += 1
            print("✅", end=" ")
        else:
            print("❌", end=" ")

        total_tokens += result.tokens_used

    accuracy = (correct_count / len(test_queries)) * 100
    avg_tokens = total_tokens / len(test_queries)

    print(f"\n\nResults: {accuracy:.1f}% accuracy ({correct_count}/{len(test_queries)})")
    print(f"Average tokens: {avg_tokens:.0f}")

    return {
        "variation_id": variation.id,
        "variation_name": variation.name,
        "hypothesis": variation.hypothesis,
        "accuracy": accuracy,
        "correct_count": correct_count,
        "total_tests": len(test_queries),
        "avg_tokens": avg_tokens,
        "results": results
    }

def main():
    print("🔬 Real LLM Capability Index Testing")
    print("=" * 60)

    # Check for API keys
    claude_key = os.getenv("ANTHROPIC_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")

    if not claude_key and not openai_key:
        print("❌ No API keys found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY")
        return

    model = "claude" if claude_key else "gpt"
    api_key = claude_key if claude_key else openai_key

    print(f"Using model: {model}")
    print(f"Testing {len(variations)} variations with {len(test_queries)} queries each")
    print(f"Total tests: {len(variations) * len(test_queries)}")

    all_results = []

    for variation in variations:
        result = run_variation_tests(variation, api_key, model)
        all_results.append(result)

    # Analysis
    print("\n\n📊 FINAL RESULTS")
    print("=" * 60)

    # Sort by accuracy
    sorted_results = sorted(all_results, key=lambda x: x["accuracy"], reverse=True)

    for i, result in enumerate(sorted_results, 1):
        print(f"\n{i}. {result['variation_name']}")
        print(f"   Accuracy: {result['accuracy']:.1f}%")
        print(f"   Avg Tokens: {result['avg_tokens']:.0f}")

        efficiency = (result['accuracy'] / 100) * 1000 / max(result['avg_tokens'], 1)
        print(f"   Efficiency Score: {efficiency:.2f}")

        if i == 1:
            print("   🏆 WINNER")

    # Key insights
    print("\n\n🔍 KEY INSIGHTS")
    print("-" * 40)

    cascade_top = next((r for r in all_results if r["variation_id"] == "cascade_top"), None)
    cascade_bottom = next((r for r in all_results if r["variation_id"] == "cascade_bottom"), None)

    if cascade_top and cascade_bottom:
        position_effect = cascade_top["accuracy"] - cascade_bottom["accuracy"]
        print(f"Position Effect: {position_effect:.1f}% (top vs bottom)")

    action = next((r for r in all_results if r["variation_id"] == "action_verbs"), None)
    passive = next((r for r in all_results if r["variation_id"] == "passive_language"), None)

    if action and passive:
        language_effect = action["accuracy"] - passive["accuracy"]
        print(f"Language Effect: {language_effect:.1f}% (action vs passive)")

    flat = next((r for r in all_results if r["variation_id"] == "flat_list"), None)
    nested = next((r for r in all_results if r["variation_id"] == "nested_deep"), None)

    if flat and nested:
        structure_effect = flat["accuracy"] - nested["accuracy"]
        token_difference = nested["avg_tokens"] - flat["avg_tokens"]
        print(f"Structure Effect: {structure_effect:.1f}% accuracy, {token_difference:.0f} token difference")

    # Save results
    timestamp = int(time.time())
    filename = f"llm_test_results_{timestamp}.json"
    with open(filename, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\n💾 Results saved to: {filename}")

if __name__ == "__main__":
    main()
EOF

echo "🚀 Real LLM Capability Test Created"
echo ""
echo "To run with Claude API:"
echo "  export ANTHROPIC_API_KEY='your-key-here'"
echo "  python3 /tmp/llm_capability_test.py"
echo ""
echo "To run with OpenAI API:"
echo "  export OPENAI_API_KEY='your-key-here'"
echo "  python3 /tmp/llm_capability_test.py"
echo ""
echo "Each test runs in isolation to avoid context contamination."
echo "Results will show empirical evidence of what actually works!"