module.exports = {
  apps: [
    {
      name: 'mcp-server',
      script: 'dist/server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10
    }
  ]
};
