/**
 * BuildInfoTools - MCP tools for retrieving build and runtime information
 */

import { IToolHandler } from '../types.js';
import { BuildInfoService } from '../../services/BuildInfoService.js';

/**
 * Get build info tools
 */
export function getBuildInfoTools(_server: IToolHandler) {
  const buildInfoService = BuildInfoService.getInstance();

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
        return buildInfoService.formatBuildInfo(info);
      }
    }
  ];
}