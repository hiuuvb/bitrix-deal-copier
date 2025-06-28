async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: [
      'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
      'START_DATE_PLAN','END_DATE_PLAN','DEADLINE','PRIORITY','STATUS','CHANGED_DATE'
    ]
  }, 'tasks');

  // Определим последнюю не завершённую задачу
  let lastOpenTask = null;
  for (const t of tasks) {
    if (!t.ID) {
      logger.warn(`⚠️ Пропускаем задачу без ID: ${JSON.stringify(t)}`);
      continue;
    }
    if (t.STATUS != 5 && (!lastOpenTask || new Date(t.CHANGED_DATE) > new Date(lastOpenTask.CHANGED_DATE))) {
      lastOpenTask = t;
    }
  }

  for (const t of tasks) {
    if (!t.ID) {
      logger.warn(`⚠️ Пропускаем задачу без ID: ${JSON.stringify(t)}`);
      continue;
    }

    const title = t.TITLE && t.TITLE.trim() ? t.TITLE : `Задача #${t.ID}`;
    const responsible = t.RESPONSIBLE_ID > 0 ? t.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;

    // По умолчанию копируем с тем же статусом, но для последней незавершённой — открываем!
    let status = t.STATUS;
    if (lastOpenTask && t.ID === lastOpenTask.ID) status = 2;

    const fields = {
      TITLE:           title,
      RESPONSIBLE_ID:  responsible,
      DESCRIPTION:     t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN || undefined,
      END_DATE_PLAN:   t.END_DATE_PLAN || undefined,
      DEADLINE:        t.DEADLINE || undefined,
      PRIORITY:        t.PRIORITY || 1,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          status
    };
    try {
      logger.info('➡️ Создаём задачу:', fields);
      const added = await btrx('tasks.task.add', { fields }, false);
      const newId = added.task?.id || added.id || added;
      logger.info(`📌 Задача ${t.ID} → ${newId} (${title})`);
      await copyChecklist(t.ID, newId);
      await copyComments(t.ID, newId);
    } catch (e) {
      logger.error(`Ошибка добавления задачи ${t.ID}: ${e.message}`);
      logger.error(JSON.stringify(fields));
    }
  }
}
