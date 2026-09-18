const express = require('express');
const router = express.Router();
const costAnalysisController = require('../controller/CostAnalysis/costAnalysis.controller');

// GET Distinct Statuses
router.get('/statuses', costAnalysisController.getOrderStatuses);

// GET Summary KPIs
router.get('/summary', costAnalysisController.getSummaryKPIs);

// GET Cost Trend Data
router.get('/trend', costAnalysisController.getCostTrend);

// GET Production Orders with Variances
router.get('/orders', costAnalysisController.getProductionOrders);

// GET Order Material Drill-down
router.get('/orders/:docEntry/materials', costAnalysisController.getOrderMaterials);

module.exports = router;
