const express = require('express');
const router = express.Router();
const { 
    getExecutiveKPIs, 
    getMaterialShortages, 
    getBatchExpiry,
    getOpenProductionOrders,
    getProductionPlans,
    createProductionPlan,
    updateProductionPlan,
    getMachines,
    createManEfficiency,
    getManEfficiency,
    createMachineEfficiency,
    getMachineEfficiency
} = require('../../controller/ProductionPlanning/productionPlanning.controller');
const {
    getProductHistory,
    getTrendData
} = require('../../controller/ProductionPlanning/productionHistory.controller');
const {
    getRecommendations
} = require('../../controller/ProductionPlanning/productionRecommendations.controller');

// Existing Routes
router.get('/kpis', getExecutiveKPIs);
router.get('/shortages', getMaterialShortages);
router.get('/batch-expiry', getBatchExpiry);
router.get('/open-orders', getOpenProductionOrders);
router.get('/machines', getMachines);

// Production Plan Routes
router.get('/plans', getProductionPlans);
router.post('/plan', createProductionPlan);
router.put('/plan/:id', updateProductionPlan);

// Man Efficiency Routes
router.get('/man-efficiency', getManEfficiency);
router.post('/man-efficiency', createManEfficiency);

// Machine Efficiency Routes
router.get('/machine-efficiency', getMachineEfficiency);
router.post('/machine-efficiency', createMachineEfficiency);

// New Routes
router.get('/history', getProductHistory);
router.get('/trend', getTrendData);
router.get('/recommendations', getRecommendations);

module.exports = router;
