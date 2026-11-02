// Startet den Server wie Claude es tut und ruft beide Tools einmal auf.
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
const client = new Client({name: 'test', version: '1'})
await client.connect(new StdioClientTransport({command: 'node', args: ['--env-file-if-exists=.env', 'server.mjs'], cwd: import.meta.dirname}))
console.log((await client.listTools()).tools.map((t) => `${t.name} readOnly=${t.annotations?.readOnlyHint}`))
for (const name of ['bahn_verbindungen', 'auto_fahrzeit']) {
	const r = await client.callTool({name, arguments: {}})
	console.log(name, r.isError ? 'ERROR' : '', r.content[0].text.slice(0, 900))
}
await client.close()
