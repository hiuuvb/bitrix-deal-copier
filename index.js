const { copyDeal, copyTasks, copyActivities } = require('./bitrix_deal_task_transfer');
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
