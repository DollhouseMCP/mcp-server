#!/usr/bin/env node
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function testToolDiscovery() {
    console.log('🔍 Comprehensive Tool Discovery Test...');
    
    // Create client transport
    const transport = new StdioClientTransport({
        command: './node_modules/.bin/tsx',
        args: ['src/index.ts']
    });

    const client = new Client(
        {
            name: 'qa-tool-discovery',
            version: '1.0.0'
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    try {
        await client.connect(transport);
        console.log('✅ Connected to MCP server');

        // Get list of tools
        const tools = await client.listTools();
        console.log(`\n📊 Available Tools: ${tools.tools.length}\n`);
        
        // Group tools by category for better organization
        const categories = {};
        tools.tools.forEach(tool => {
            const category = categorizeTools(tool.name);
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(tool);
        });

        // Display tools by category
        Object.keys(categories).sort().forEach(category => {
            console.log(`\n📂 ${category.toUpperCase()} (${categories[category].length} tools):`);
            categories[category].forEach(tool => {
                console.log(`   ✓ ${tool.name}: ${tool.description.substring(0, 60)}...`);
            });
        });

        // Test a sample from each category
        console.log('\n🧪 Testing Sample Tools...\n');
        
        const sampleTests = [
            'get_user_identity',
            'list_elements', 
            'get_element_details'
        ];

        for (const toolName of sampleTests) {
            try {
                const start = Date.now();
                const result = await client.callTool({
                    name: toolName,
                    arguments: toolName === 'list_elements' ? { element_type: 'personas' } : 
                              toolName === 'get_element_details' ? { element_type: 'personas', name: 'test' } : {}
                });
                const duration = Date.now() - start;
                console.log(`   ✅ ${toolName}: Success (${duration}ms)`);
            } catch (error) {
                const duration = Date.now() - start;
                console.log(`   ⚠️  ${toolName}: ${error.message} (${duration}ms)`);
            }
        }

        await client.close();
        
        console.log('\n✅ Tool discovery completed successfully!');
        return tools;
        
    } catch (error) {
        console.error('❌ Error during tool discovery:', error);
        throw error;
    }
}

function categorizeTools(toolName) {
    if (toolName.includes('element') || toolName.includes('persona') || toolName.includes('skill')) {
        return 'Elements';
    } else if (toolName.includes('github') || toolName.includes('auth') || toolName.includes('oauth')) {
        return 'GitHub Integration';
    } else if (toolName.includes('portfolio') || toolName.includes('config')) {
        return 'Portfolio Management';
    } else if (toolName.includes('marketplace') || toolName.includes('browse')) {
        return 'Marketplace';
    } else if (toolName.includes('user') || toolName.includes('identity')) {
        return 'User Management';
    } else {
        return 'Other';
    }
}

// Run the test
testToolDiscovery().catch(console.error);