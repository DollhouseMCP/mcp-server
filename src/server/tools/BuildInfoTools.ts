/**
 * BuildInfoTools - MCP tools for retrieving build and runtime information
 */

import { BuildInfoService } from '../../services/BuildInfoService.js';

/**
 * Get build info tools
 */
export function getBuildInfoTools(buildInfoService: BuildInfoService) {
  return [
    {
      tool: {
        name: 'get_build_info',
        description: 'Get comprehensive build and runtime information about the server',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: []
        }
      },
      handler: async () => {
        const info = await buildInfoService.getBuildInfo();
        const formattedInfo = buildInfoService.formatBuildInfo(info);
        return {
          structuredContent: info,
          content: [
            {
              type: "text",
              text: formattedInfo
            }
          ]
        };
      }
    }
  ];
}
