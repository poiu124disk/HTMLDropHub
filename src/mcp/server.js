import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { PUBLIC_BASE_URL } from '../config.js';
import { saveAppFile, deleteAppFile } from '../services/storage.js';
import { metadataStore } from '../services/metadata-store.js';
import { extractHtmlMetadata, SecurityError } from '../auth/security.js';

// Map of active SSE sessions: sessionId -> { transport, server, apiKey }
const activeSessions = new Map();

/**
 * Creates an McpServer instance bound to a specific API Key and scope
 */
export function createScopedMcpServer(apiKey) {
  const server = new McpServer({
    name: `HTMLDropHub-${apiKey.scope}`,
    version: '1.0.0'
  });

  // Tool 1: drop_html
  server.tool(
    'drop_html',
    'Deploy a single-file HTML micro-application into the user\'s scoped hosting directory.',
    {
      filename: z.string().describe('Target filename, must end with .html or .htm (e.g., "dashboard.html", "calculator.html")'),
      content: z.string().describe('Full HTML source code of the standalone micro-app (can contain embedded CSS and JS)'),
      title: z.string().optional().describe('Optional human-readable title for the application card in the catalog'),
      description: z.string().optional().describe('Optional short description explaining what this micro-app does')
    },
    async ({ filename, content, title, description }) => {
      try {
        const scope = apiKey.scope;

        // Auto-extract metadata from HTML if not explicitly supplied
        const extracted = extractHtmlMetadata(content, filename);
        const appTitle = title?.trim() || extracted.title;
        const appDescription = description?.trim() !== undefined ? description.trim() : extracted.description;

        // Save file with chroot security checks and size validation
        const saved = await saveAppFile(scope, filename, content, {
          allowOverwrite: apiKey.allowOverwrite,
          maxFileSizeMb: apiKey.maxFileSizeMb
        });

        // Update metadata store
        await metadataStore.saveApp(scope, saved.filename, {
          title: appTitle,
          description: appDescription,
          sizeBytes: saved.sizeBytes
        });

        const appUrl = `${PUBLIC_BASE_URL}/${scope}/${saved.filename}`;
        const responseMessage = [
          `🎉 Successfully deployed micro-app!`,
          `- Title: ${appTitle}`,
          `- Scope Folder: ${scope}`,
          `- Filename: ${saved.filename}`,
          `- Size: ${(saved.sizeBytes / 1024).toFixed(2)} KB`,
          `- Access URL: ${appUrl}`,
          ``,
          `You can view or share it right now at: ${appUrl}`
        ].join('\n');

        return {
          content: [
            {
              type: 'text',
              text: responseMessage
            }
          ]
        };
      } catch (err) {
        const errorMsg = err instanceof SecurityError
          ? `[Security Violation] ${err.message}`
          : `[Deployment Failed] ${err.message}`;

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorMsg
            }
          ]
        };
      }
    }
  );

  // Tool 2: list_my_apps
  server.tool(
    'list_my_apps',
    'List all HTML micro-applications currently hosted within your scoped directory.',
    {},
    async () => {
      try {
        const apps = await metadataStore.getAppsByScope(apiKey.scope);
        if (apps.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No micro-apps found in scope "${apiKey.scope}". Use "drop_html" to deploy your first app!`
              }
            ]
          };
        }

        const lines = apps.map((app, idx) => {
          const url = `${PUBLIC_BASE_URL}${app.urlPath}`;
          return `${idx + 1}. **${app.title}** (${app.filename})\n   - URL: ${url}\n   - Size: ${(app.sizeBytes / 1024).toFixed(2)} KB\n   - Updated: ${app.updatedAt}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Apps in scope "${apiKey.scope}" (${apps.length} total):\n\n${lines.join('\n\n')}`
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to list apps: ${err.message}` }]
        };
      }
    }
  );

  // Tool 3: delete_my_app
  server.tool(
    'delete_my_app',
    'Delete a micro-application from your scoped directory.',
    {
      filename: z.string().describe('Filename of the app to delete (e.g. "old_chart.html")')
    },
    async ({ filename }) => {
      try {
        const res = await deleteAppFile(apiKey.scope, filename);
        if (res.notFound) {
          return {
            isError: true,
            content: [{ type: 'text', text: `App "${filename}" not found in scope "${apiKey.scope}".` }]
          };
        }

        await metadataStore.removeApp(apiKey.scope, filename);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully deleted "${filename}" from scope "${apiKey.scope}".`
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to delete app: ${err.message}` }]
        };
      }
    }
  );

  // Tool 4: get_my_info
  server.tool(
    'get_my_info',
    'Retrieve current API Key configuration, bound scope directory, and upload constraints.',
    {},
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              keyName: apiKey.name,
              scopeDirectory: apiKey.scope,
              allowOverwrite: apiKey.allowOverwrite,
              maxFileSizeMb: apiKey.maxFileSizeMb,
              publicBaseUrl: PUBLIC_BASE_URL
            }, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

/**
 * Handles incoming SSE connection: GET /sse
 */
export async function handleSseConnection(req, res) {
  const apiKey = req.apiKey;
  const transport = new SSEServerTransport('/messages', res);
  const server = createScopedMcpServer(apiKey);

  const sessionId = transport.sessionId;
  activeSessions.set(sessionId, { transport, server, apiKey });

  res.on('close', () => {
    activeSessions.delete(sessionId);
  });

  await server.connect(transport);
}

/**
 * Handles incoming message post: POST /messages
 */
export async function handleMessagesPost(req, res) {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId query parameter' });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (err) {
    console.error('[MCP PostMessage Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process MCP message', details: err.message });
    }
  }
}
