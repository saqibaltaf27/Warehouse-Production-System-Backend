const express = require('express');
const router = express.Router();
const dashboardController = require('../../controller/Dashboard/dashboard.controller');
const authenticateToken = require('../../middleware/auth.middleware');

router.get('/overview', authenticateToken, dashboardController.getOverviewData);
router.get('/alerts', authenticateToken, dashboardController.getAlerts);
router.get('/plan-vs-actual', authenticateToken, dashboardController.getPlanVsActual);
router.get('/cost-summary', authenticateToken, dashboardController.getCostSummary);
router.get('/cost-variance', authenticateToken, dashboardController.getCostVariance);
router.get('/material-shortages', authenticateToken, dashboardController.getMaterialShortages);
router.get('/efficiency', authenticateToken, dashboardController.getEfficiency);
router.get('/downtime', authenticateToken, dashboardController.getDowntime);
router.get('/oee', authenticateToken, dashboardController.getOEE);
router.get('/quality', authenticateToken, dashboardController.getQuality);
router.get('/order-summary', authenticateToken, dashboardController.getOrderSummary);
router.get('/warehouses', authenticateToken, dashboardController.getWarehouses);

module.exports = router;
