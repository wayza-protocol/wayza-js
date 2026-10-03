// Copies node icons (svg/png) next to the compiled node files, like the starter's gulp task.
const fs = require('fs');
const path = require('path');

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const from = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(from);
		else if (/\.(svg|png)$/.test(entry.name)) {
			const to = path.join('dist', from);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
		}
	}
}
for (const root of ['nodes', 'credentials']) if (fs.existsSync(root)) walk(root);
