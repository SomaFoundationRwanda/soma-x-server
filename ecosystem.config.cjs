// pm2 start ecosystem.config.cjs   (after `npm run build`)
module.exports = {
    apps: [
        {
            name: 'soma-x-server',
            // .env and relative paths (content/, data/) resolve from the repo, wherever pm2 is started.
            cwd: __dirname,
            script: 'dist/index.js',
            node_args: '--env-file-if-exists=.env',
            // One instance: the folder watcher and indexer must not run twice.
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '1G',
            kill_timeout: 10000,
        },
    ],
};
