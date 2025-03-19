// api/health.js
module.exports = async (req, res) => {
    try {
      if (req.method === 'GET') {
        // Можно добавить дополнительные проверки состояния, если нужно
        res.status(200).json({
          status: 'ok',
          timestamp: new Date().toISOString(),
          message: 'Server is running'
        });
      } else {
        res.status(405).json({ error: 'Method not allowed' });
      }
    } catch (error) {
      res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
      });
    }
  };