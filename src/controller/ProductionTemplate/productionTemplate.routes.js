const express = require('express');
const router = express.Router();
const ProductionTemplateController = require('./productionTemplate.controller');

router.get('/orders', ProductionTemplateController.getProductionOrders);
router.get('/manpower', ProductionTemplateController.getManpowerProductivity);
router.post('/manpower', ProductionTemplateController.addManpowerProductivity);
router.get('/efficiency', ProductionTemplateController.getDailyEfficiency);
router.post('/efficiency', ProductionTemplateController.addDailyEfficiency);
router.get('/quality', ProductionTemplateController.getQualityPerformance);
router.post('/quality', ProductionTemplateController.addQualityPerformance);

module.exports = router;
