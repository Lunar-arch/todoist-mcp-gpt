import { NextRequest } from 'next/server';

const TODOIST_TOKEN = process.env.TODOIST_TOKEN!;
const TODOIST_API = 'https://api.todoist.com/rest/v2';

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await req.json();
        const { method, params } = body;

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
                description: 'Create a new task in Todoist with full control over all properties including recurring schedules',
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
                      description: 'Project ID - use get_projects or get_project_by_name to find IDs (optional)' 
                    },
                    project_name: {
                      type: 'string',
                      description: 'Project name - will auto-lookup project ID (optional, easier than project_id)'
                    },
                    priority: { 
                      type: 'number', 
                      description: 'Priority: 1 (normal) to 4 (urgent) (optional, default: 1)' 
                    },
                    due_string: { 
                      type: 'string', 
                      description: 'Natural language due date. Examples: "tomorrow at 3pm", "every Monday", "every weekday at 9am", "every Monday and Friday at 2pm", "Jan 23 at 5pm" (optional)' 
                    },
                    labels: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Array of label names to add to task (optional)'
                    },
                    due_datetime: {
                      type: 'string',
                      description: 'Specific date/time in RFC3339 format with UTC offset. Use this for precise scheduling. Example: "2025-01-30T15:00:00-06:00" (optional, alternative to due_string)'
                    }
                  },
                  required: ['content']
                }
              },
              {
                name: 'batch_create_tasks',
                description: 'Create multiple tasks at once. Efficient for adding several tasks in one operation.',
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
                          description: { type: 'string', description: 'Task description (optional)' },
                          project_id: { type: 'string', description: 'Project ID (optional)' },
                          project_name: { type: 'string', description: 'Project name for auto-lookup (optional)' },
                          priority: { type: 'number', description: 'Priority 1-4 (optional)' },
                          due_string: { type: 'string', description: 'Natural language due date (optional)' },
                          labels: { type: 'array', items: { type: 'string' }, description: 'Labels (optional)' }
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
                description: 'Intelligently add tasks with AI-powered project categorization and smart defaults. Best for: "Add these tasks and organize them into the right projects"',
                inputSchema: {
                  type: 'object',
                  properties: {
                    tasks: {
                      type: 'array',
                      description: 'Array of task descriptions (plain text). AI will categorize and set appropriate defaults.',
                      items: { type: 'string' }
                    },
                    context: {
                      type: 'string',
                      description: 'Additional context about these tasks to help with categorization (optional)'
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
                    due_string: { type: 'string', description: 'New due date in natural language (optional)' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'New labels (replaces existing) (optional)' }
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
                description: 'Find a project by its name and return its ID. Useful for getting project IDs without listing all projects.',
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
                    project_name: { type: 'string', description: 'Project name for auto-lookup (optional)' }
                  }
                }
              }
            ]
          };
        }

        // Handle tool calls
        else if (method === 'tools/call') {
          const { name, arguments: args } = params;

          // Helper: Get project ID from name
          const getProjectIdByName = async (name: string): Promise<string | null> => {
            const projectsRes = await fetch(`${TODOIST_API}/projects`, {
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
                'Authorization': `Bearer ${TODOIST_TOKEN}`,
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
                    'Authorization': `Bearer ${TODOIST_TOKEN}`,
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
                'Authorization': `Bearer ${TODOIST_TOKEN}`,
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
                headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
                headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
                headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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
              headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
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

        // Send SSE formatted response
        const data = `data: ${JSON.stringify(responseData)}\n\n`;
        controller.enqueue(encoder.encode(data));
        controller.close();

      } catch (error: any) {
        console.error('MCP Error:', error);
        const errorData = `data: ${JSON.stringify({ error: error.message })}\n\n`;
        controller.enqueue(encoder.encode(errorData));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}