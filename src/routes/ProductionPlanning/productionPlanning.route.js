const express = require('express');
const router = express.Router();
const { 
    getExecutiveKPIs, 
    getMaterialShortages, 
    getBatchExpiry,
    getManpowerProductivity,
    addManpowerProductivity
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

// New Routes
router.get('/history', getProductHistory);
router.get('/trend', getTrendData);
router.get('/recommendations', getRecommendations);
router.get('/manpower', getManpowerProductivity);
router.post('/manpower', addManpowerProductivity);

module.exports = router;
