const express = require('express');
const router = express.Router();
const pmController = require('../../controller/PreventiveMaintenance/pm.controller');

router.get('/filters', pmController.getFilters);
router.get('/summary', pmController.getSummary);
router.get('/charts', pmController.getChartsData);
router.get('/upcoming', pmController.getUpcomingMaintenance);
router.get('/yearly-schedule', pmController.getYearlySchedule);

router.post('/instrument', pmController.addInstrument);
router.put('/instrument/:id', pmController.updateInstrument);

module.exports = router;
