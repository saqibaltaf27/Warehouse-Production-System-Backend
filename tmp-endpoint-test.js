require('dotenv').config();
const c = require('./src/controller/Dashboard/dashboard.controller');

const run = (fn, query) => new Promise((resolve) => {
  const res = {
    status: () => res,
    json: (payload) => resolve(payload),
  };
  fn({ query }, res).catch((e) => resolve({ THROWN: e.message }));
});

(async () => {
  const head = await run(c.getProductionHeadOverview, {});
  console.log('--- production-head-overview ---');
  console.log(JSON.stringify(head, null, 1));

  const exc = await run(c.getProductionExceptions, { bucket: 'overdue', page: 1, limit: 3 });
  console.log('--- production-exceptions (overdue) ---');
  console.log(JSON.stringify(exc, null, 1));

  const excSearch = await run(c.getProductionExceptions, { bucket: 'all', page: 1, limit: 2, search: 'SUGAR' });
  console.log('--- production-exceptions (search SUGAR) ---');
  console.log(JSON.stringify(excSearch.pagination, null, 1), excSearch.data.orders.map(o => o.ProductName));

  const sh = await run(c.getProductionOrderShortages, { page: 1, limit: 3 });
  console.log('--- production-order-shortages ---');
  console.log(JSON.stringify(sh, null, 1));

  const ach = await run(c.getMonthlyProductionAchievement, { month: 10, year: 2026, page: 1, limit: 2 });
  console.log('--- monthly-production-achievement (Oct 2026) ---');
  const { orders, ...rest } = ach.data || {};
  console.log(JSON.stringify({ ...rest, pagination: ach.pagination, firstOrder: orders && orders[0] }, null, 1));

  const sep = await run(c.getMonthlyProductionAchievement, { month: 9, year: 2026, page: 1, limit: 1 });
  console.log('--- monthly-production-achievement (Sep 2026) ---');
  const { orders: o2, ...rest2 } = sep.data || {};
  console.log(JSON.stringify(rest2, null, 1));

  process.exit(0);
})();
