import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const TODOIST_API = 'https://api.todoist.com/rest/v2';

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
};

const encoder = new TextEncoder();

// In serverless environments, GET and POST may hit different instances.
// Use a queue (Upstash/Vercel KV) so GET can poll and stream messages reliably.
const inMemoryQueues = new Map<string, string[]>();

function normalizeEnv(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") )
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.endsWith('/') ? unquoted.slice(0, -1) : unquoted;
}

const UPSTASH_URL = normalizeEnv(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = normalizeEnv(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);

async function upstashCmd(command: string, args: Array<string | number> = []) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const path = [command, ...args].map((a) => encodeURIComponent(String(a))).join('/');
  const res = await fetch(`${UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function queuePush(sessionId: string, message: unknown) {
  const payload = JSON.stringify(message);
  const key = `mcp:sse:${sessionId}`;

  // Prefer Upstash/Vercel KV if configured
  const pushed = await upstashCmd('rpush', [key, payload]);
  if (pushed) {
    await upstashCmd('expire', [key, 600]);
    return;
  }

  // Fallback: in-memory (works in dev / single instance)
  const q = inMemoryQueues.get(sessionId) || [];
  q.push(payload);
  inMemoryQueues.set(sessionId, q);
}

async function queuePopMany(sessionId: string, max: number) {
  const key = `mcp:sse:${sessionId}`;

  const popped = await upstashCmd('lpop', [key, max]);
  if (popped && Array.isArray(popped.result)) {
    return popped.result as string[];
  }

  const q = inMemoryQueues.get(sessionId) || [];
  if (q.length === 0) return [];
  const out = q.splice(0, max);
  if (q.length === 0) inMemoryQueues.delete(sessionId);
  return out;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
} as const;

function sseHeaders() {
  return {
    ...corsHeaders,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none'
  } as Record<string, string>;
}

function sse(data: string) {
  return encoder.encode(data);
}

function sseEvent(event: string | null, data: unknown) {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return sse(lines.join('\n') + '\n\n');
}

function sseComment(comment: string) {
  return sse(`: ${comment}\n\n`);
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function parseJsonBody(req: NextRequest): Promise<any> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return req.json();
  }
  const text = await req.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function handleMcpMethod(method: string, params: any) {
  let responseData: any;

  // List available tools
  if (method === 'tools/list') {
    responseData = {
      tools: [
        {
          name: 'search',
          description: 'Search for tasks in Todoist by keyword',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query to find tasks'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'fetch',
          description: 'Get full details of a specific Todoist task',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Task ID to fetch'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'create_task',
          description:
            'Create a new task in Todoist with full control over all properties including recurring schedules',
          inputSchema: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Task title/content'
              },
              description: {
                type: 'string',
                description: 'Detailed task description (optional)'
              },
              project_id: {
                type: 'string',
                description:
                  'Project ID - use get_projects or get_project_by_name to find IDs (optional)'
              },
              project_name: {
                type: 'string',
                description:
                  'Project name - will auto-lookup project ID (optional, easier than project_id)'
              },
              priority: {
                type: 'number',
                description: 'Priority: 1 (normal) to 4 (urgent) (optional, default: 1)'
              },
              due_string: {
                type: 'string',
                description:
                  'Natural language due date. Examples: "tomorrow at 3pm", "every Monday", "every weekday at 9am", "every Monday and Friday at 2pm", "Jan 23 at 5pm" (optional)'
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of label names to add to task (optional)'
              },
              due_datetime: {
                type: 'string',
                description:
                  'Specific date/time in RFC3339 format with UTC offset. Use this for precise scheduling. Example: "2025-01-30T15:00:00-06:00" (optional, alternative to due_string)'
              }
            },
            required: ['content']
          }
        },
        {
          name: 'batch_create_tasks',
          description:
            'Create multiple tasks at once. Efficient for adding several tasks in one operation.',
          inputSchema: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                description: 'Array of task objects to create',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string', description: 'Task title' },
                    description: {
                      type: 'string',
                      description: 'Task description (optional)'
                    },
                    project_id: { type: 'string', description: 'Project ID (optional)' },
                    project_name: {
                      type: 'string',
                      description: 'Project name for auto-lookup (optional)'
                    },
                    priority: { type: 'number', description: 'Priority 1-4 (optional)' },
                    due_string: {
                      type: 'string',
                      description: 'Natural language due date (optional)'
                    },
                    labels: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Labels (optional)'
                    }
                  },
                  required: ['content']
                }
              }
            },
            required: ['tasks']
          }
        },
        {
          name: 'smart_add_tasks',
          description:
            'Intelligently add tasks with AI-powered project categorization and smart defaults. Best for: "Add these tasks and organize them into the right projects"',
          inputSchema: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                description:
                  'Array of task descriptions (plain text). AI will categorize and set appropriate defaults.',
                items: { type: 'string' }
              },
              context: {
                type: 'string',
                description:
                  'Additional context about these tasks to help with categorization (optional)'
              }
            },
            required: ['tasks']
          }
        },
        {
          name: 'update_task',
          description: 'Update an existing task. Can modify any field.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Task ID to update' },
              content: { type: 'string', description: 'New task title (optional)' },
              description: { type: 'string', description: 'New description (optional)' },
              priority: { type: 'number', description: 'New priority 1-4 (optional)' },
              due_string: {
                type: 'string',
                description: 'New due date in natural language (optional)'
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'New labels (replaces existing) (optional)'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'complete_task',
          description: 'Mark a task as complete',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Task ID to complete' }
            },
            required: ['id']
          }
        },
        {
          name: 'get_projects',
          description: 'List all Todoist projects with their IDs and metadata',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_project_by_name',
          description:
            'Find a project by its name and return its ID. Useful for getting project IDs without listing all projects.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Project name to search for (case-insensitive)'
              }
            },
            required: ['name']
          }
        },
        {
          name: 'get_tasks_by_project',
          description: 'Get all tasks in a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              project_id: { type: 'string', description: 'Project ID (optional)' },
              project_name: {
                type: 'string',
                description: 'Project name for auto-lookup (optional)'
              }
            }
          }
        }
      ]
    };
  }

  // Handle tool calls
  else if (method === 'tools/call') {
    const { name, arguments: args } = params;

    const token = TODOIST_TOKEN;

    if (!token) {
      throw new Error('TODOIST_TOKEN is not set');
    }

          // Helper: Get project ID from name
          const getProjectIdByName = async (name: string): Promise<string | null> => {
            const projectsRes = await fetch(`${TODOIST_API}/projects`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!projectsRes.ok) return null;
            const projects = await projectsRes.json();
            const project = projects.find((p: any) => 
              p.name.toLowerCase() === name.toLowerCase()
            );
            return project?.id || null;
          };

          // SEARCH
          if (name === 'search') {
            const tasksRes = await fetch(`${TODOIST_API}/tasks`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!tasksRes.ok) {
              throw new Error(`Todoist API error: ${tasksRes.status}`);
            }

            const tasks = await tasksRes.json();
            const query = args.query.toLowerCase();
            
            const filtered = tasks.filter((t: any) => 
              t.content.toLowerCase().includes(query) ||
              (t.description && t.description.toLowerCase().includes(query))
            );

            const results = filtered.slice(0, 10).map((t: any) => ({
              id: t.id,
              title: t.content,
              url: t.url
            }));

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({ results })
              }]
            };
          }

          // FETCH
          else if (name === 'fetch') {
            const taskRes = await fetch(`${TODOIST_API}/tasks/${args.id}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!taskRes.ok) {
              throw new Error(`Task not found: ${args.id}`);
            }

            const task = await taskRes.json();

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  id: task.id,
                  title: task.content,
                  text: `Task: ${task.content}\n${task.description ? `Description: ${task.description}\n` : ''}Project ID: ${task.project_id}\nPriority: ${task.priority}\nDue: ${task.due?.string || 'No due date'}\nLabels: ${task.labels.join(', ') || 'None'}`,
                  url: task.url,
                  metadata: {
                    project_id: task.project_id,
                    priority: task.priority,
                    labels: task.labels,
                    due: task.due
                  }
                })
              }]
            };
          }

          // CREATE TASK
          else if (name === 'create_task') {
            let projectId = args.project_id;
            
            if (args.project_name && !projectId) {
              projectId = await getProjectIdByName(args.project_name);
              if (!projectId) {
                throw new Error(`Project "${args.project_name}" not found`);
              }
            }

            const taskData: any = {
              content: args.content,
              ...(args.description && { description: args.description }),
              ...(projectId && { project_id: projectId }),
              ...(args.priority && { priority: args.priority }),
              ...(args.due_string && { due_string: args.due_string }),
              ...(args.due_datetime && { due_datetime: args.due_datetime }),
              ...(args.labels && { labels: args.labels })
            };

            const taskRes = await fetch(`${TODOIST_API}/tasks`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(taskData)
            });

            if (!taskRes.ok) {
              const error = await taskRes.text();
              throw new Error(`Failed to create task: ${taskRes.status} - ${error}`);
            }

            const task = await taskRes.json();

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  task_id: task.id,
                  content: task.content,
                  project_id: task.project_id,
                  due: task.due,
                  url: task.url
                })
              }]
            };
          }

          // BATCH CREATE TASKS
          else if (name === 'batch_create_tasks') {
            const results = [];
            const errors = [];

            for (const taskDef of args.tasks) {
              try {
                let projectId = taskDef.project_id;
                
                if (taskDef.project_name && !projectId) {
                  projectId = await getProjectIdByName(taskDef.project_name);
                }

                const taskData: any = {
                  content: taskDef.content,
                  ...(taskDef.description && { description: taskDef.description }),
                  ...(projectId && { project_id: projectId }),
                  ...(taskDef.priority && { priority: taskDef.priority }),
                  ...(taskDef.due_string && { due_string: taskDef.due_string }),
                  ...(taskDef.labels && { labels: taskDef.labels })
                };

                const taskRes = await fetch(`${TODOIST_API}/tasks`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(taskData)
                });

                if (taskRes.ok) {
                  const task = await taskRes.json();
                  results.push({
                    success: true,
                    task_id: task.id,
                    content: task.content
                  });
                } else {
                  errors.push({
                    content: taskDef.content,
                    error: `HTTP ${taskRes.status}`
                  });
                }
              } catch (error: any) {
                errors.push({
                  content: taskDef.content,
                  error: error.message
                });
              }
            }

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  created: results.length,
                  failed: errors.length,
                  results,
                  errors
                })
              }]
            };
          }

          // SMART ADD TASKS
          else if (name === 'smart_add_tasks') {
            const projectsRes = await fetch(`${TODOIST_API}/projects`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const projects = projectsRes.ok ? await projectsRes.json() : [];
            
            const projectList = projects.map((p: any) => `${p.name} (ID: ${p.id})`).join(', ');
            
            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  message: 'Smart add received. Analyze the tasks and use batch_create_tasks with appropriate project assignments.',
                  tasks: args.tasks,
                  context: args.context,
                  available_projects: projectList,
                  instruction: 'Based on task content, assign each to the most appropriate project using project_name or project_id in batch_create_tasks. Infer due dates and priorities from context.'
                })
              }]
            };
          }

          // UPDATE TASK
          else if (name === 'update_task') {
            const { id, ...updates } = args;
            
            const taskRes = await fetch(`${TODOIST_API}/tasks/${id}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(updates)
            });

            if (!taskRes.ok) {
              throw new Error(`Failed to update task: ${taskRes.status}`);
            }

            const task = await taskRes.json();

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  task_id: task.id,
                  content: task.content,
                  url: task.url
                })
              }]
            };
          }

          // COMPLETE TASK
          else if (name === 'complete_task') {
            const completeRes = await fetch(`${TODOIST_API}/tasks/${args.id}/close`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!completeRes.ok) {
              throw new Error(`Failed to complete task: ${completeRes.status}`);
            }

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Task ${args.id} marked as complete`
                })
              }]
            };
          }

          // GET PROJECTS
          else if (name === 'get_projects') {
            const projectsRes = await fetch(`${TODOIST_API}/projects`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!projectsRes.ok) {
              throw new Error(`Failed to fetch projects: ${projectsRes.status}`);
            }

            const projects = await projectsRes.json();

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  projects: projects.map((p: any) => ({
                    id: p.id,
                    name: p.name,
                    color: p.color,
                    is_favorite: p.is_favorite,
                    view_style: p.view_style
                  }))
                })
              }]
            };
          }

          // GET PROJECT BY NAME
          else if (name === 'get_project_by_name') {
            const getProjectIdByName = async (name: string): Promise<string | null> => {
              const projectsRes = await fetch(`${TODOIST_API}/projects`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (!projectsRes.ok) return null;
              const projects = await projectsRes.json();
              const project = projects.find((p: any) => 
                p.name.toLowerCase() === name.toLowerCase()
              );
              return project?.id || null;
            };

            const projectId = await getProjectIdByName(args.name);
            
            if (!projectId) {
              responseData = {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    found: false,
                    message: `Project "${args.name}" not found`
                  })
                }]
              };
            } else {
              const projectRes = await fetch(`${TODOIST_API}/projects/${projectId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });

              const project = await projectRes.json();

              responseData = {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    found: true,
                    id: project.id,
                    name: project.name,
                    color: project.color,
                    is_favorite: project.is_favorite
                  })
                }]
              };
            }
          }

          // GET TASKS BY PROJECT
          else if (name === 'get_tasks_by_project') {
            const getProjectIdByName = async (name: string): Promise<string | null> => {
              const projectsRes = await fetch(`${TODOIST_API}/projects`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (!projectsRes.ok) return null;
              const projects = await projectsRes.json();
              const project = projects.find((p: any) => 
                p.name.toLowerCase() === name.toLowerCase()
              );
              return project?.id || null;
            };

            let projectId = args.project_id;
            
            if (args.project_name && !projectId) {
              projectId = await getProjectIdByName(args.project_name);
              if (!projectId) {
                throw new Error(`Project "${args.project_name}" not found`);
              }
            }

            const url = projectId 
              ? `${TODOIST_API}/tasks?project_id=${projectId}`
              : `${TODOIST_API}/tasks`;

            const tasksRes = await fetch(url, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!tasksRes.ok) {
              throw new Error(`Failed to fetch tasks: ${tasksRes.status}`);
            }

            const tasks = await tasksRes.json();

            responseData = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  project_id: projectId,
                  count: tasks.length,
                  tasks: tasks.map((t: any) => ({
                    id: t.id,
                    content: t.content,
                    priority: t.priority,
                    due: t.due,
                    labels: t.labels,
                    url: t.url
                  }))
                })
              }]
            };
          }

          else {
            throw new Error(`Unknown tool: ${name}`);
          }
        }

  // Some clients send notifications as requests (id:null) or without id.
  else if (method === 'notifications/initialized') {
    responseData = {};
  }

  // Common MCP methods some clients probe for
  else if (method === 'resources/list') {
    responseData = { resources: [] };
  }

  else if (method === 'prompts/list') {
    responseData = { prompts: [] };
  }

  // Common MCP methods some clients probe for
  else if (method === 'resources/list') {
    responseData = { resources: [] };
  }

  else if (method === 'prompts/list') {
    responseData = { prompts: [] };
  }


  // Handle initialization/ping
  else if (method === 'initialize') {
    responseData = {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'todoist-mcp',
        version: '1.0.0'
      }
    };
  }

  else if (method === 'ping') {
    responseData = {};
  }

  else {
    throw new Error('Unknown method');
  }

  return responseData;
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const sessionId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // MCP SSE handshake: provide the message endpoint.
      const endpointUrl = `${req.nextUrl.origin}${req.nextUrl.pathname}?sessionId=${encodeURIComponent(sessionId)}`;
      controller.enqueue(sseEvent('endpoint', endpointUrl));
      controller.enqueue(sseComment('connected'));

      let draining = false;
      const drainInterval = setInterval(async () => {
        if (draining) return;
        draining = true;
        try {
          const items = await queuePopMany(sessionId, 50);
          for (const raw of items) {
            try {
              controller.enqueue(sseEvent('message', JSON.parse(raw)));
            } catch {
              // ignore malformed queued items
            }
          }
        } finally {
          draining = false;
        }
      }, 250);

      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(sseComment('ping'));
        } catch {
          // no-op
        }
      }, 15000);

      const abort = () => {
        clearInterval(drainInterval);
        clearInterval(pingInterval);
        try {
          controller.close();
        } catch {
          // no-op
        }
      };
      req.signal.addEventListener('abort', abort, { once: true });
    },
    cancel() {
      // no-op
    }
  });

  return new Response(stream, {
	headers: sseHeaders()
  });
}

export async function POST(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
	const debug = req.nextUrl.searchParams.get('debug') === '1';

  // If we have a sessionId, this is a message POST that should be queued for the SSE stream.
  if (sessionId) {
    let body: JsonRpcRequest | null = null;
    try {
      body = (await parseJsonBody(req)) as JsonRpcRequest;
    } catch (error: any) {
      const err = jsonRpcError(null, -32700, error?.message || 'Parse error');
		await queuePush(sessionId, err);
		return Response.json(debug ? { ok: false, forwarded: err } : { ok: false }, {
			status: 200,
			headers: corsHeaders
		});
    }

    const method = body?.method;
    const params = body?.params;
    const id: JsonRpcId = body?.id ?? null;
    const hasId = !!body && Object.prototype.hasOwnProperty.call(body, 'id');

    // JSON-RPC notifications have no id and must not receive a response.
    if (!hasId) {
      try {
        // Some clients send notifications/initialized; ignore any result.
        if (method) {
          await handleMcpMethod(method, params);
        }
      } catch {
        // swallow
      }
      return Response.json({ ok: true }, { status: 200, headers: corsHeaders });
    }

    if (!method) {
    const err = jsonRpcError(id, -32600, 'Invalid Request');
		await queuePush(sessionId, err);
    return Response.json(debug ? { ok: false, forwarded: err } : { ok: false }, {
      status: 200,
      headers: corsHeaders
    });
    }

    try {
      const result = await handleMcpMethod(method, params);
    const okMsg = jsonRpcResult(id, result);
		await queuePush(sessionId, okMsg);
    return Response.json(debug ? { ok: true, forwarded: okMsg } : { ok: true }, {
      status: 200,
      headers: corsHeaders
    });
    } catch (error: any) {
      const message = error?.message || 'Internal error';
      const code = message === 'Unknown method' ? -32601 : -32603;
    const err = jsonRpcError(id, code, message);
		await queuePush(sessionId, err);
    return Response.json(debug ? { ok: false, forwarded: err } : { ok: false }, {
      status: 200,
      headers: corsHeaders
    });
    }
  }

  // Back-compat: direct POST that returns a single SSE response and closes.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let body: any;
      try {
        body = await parseJsonBody(req);
        const method = body?.method;
        const params = body?.params;
        if (!method) throw new Error('Invalid Request');

        const responseData = await handleMcpMethod(method, params);
        controller.enqueue(sseEvent(null, responseData));
        controller.close();
      } catch (error: any) {
        controller.enqueue(sseEvent(null, { error: error?.message || 'Internal error' }));
        controller.close();
      }
    }
  });

  return new Response(stream, {
	headers: sseHeaders()
  });
}