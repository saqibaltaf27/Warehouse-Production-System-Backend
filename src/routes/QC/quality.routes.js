const express = require('express');
const router = express.Router();
const qualityController = require('../../controller/QC/quality.controller');

router.get('/quality-records', qualityController.getQualityRecords);
router.get('/quality-record/:docEntry', qualityController.getQualityRecordDetails);

module.exports = router;
