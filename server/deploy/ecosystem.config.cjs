module.exports = {
  apps: [
    {
      name: 'yiwu-ai-server',
      script: 'src/server.js',
      cwd: '/var/www/yiwu-ai/server',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      }
    }
  ]
};
