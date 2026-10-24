const express = require('express');
const router = express.Router();
const qualityController = require('../../controller/QC/quality.controller');
router.get('/quality-records', qualityController.getQualityRecords);
router.get('/quality-decisions', qualityController.getQualityDecisions);
router.get('/quality-record/:docEntry', qualityController.getQualityRecordDetails);
router.get('/items', qualityController.getItems);
router.get('/equipments', qualityController.getEquipments);
router.get('/next-doc-entry', qualityController.getNextDocEntry);
router.get('/item-by-code', qualityController.getItemByCode);
router.get('/testing-standards', qualityController.getTestingStandards);
router.get('/item-batches', qualityController.getItemBatches);
router.get('/parameters', qualityController.getParameters);
router.get('/employees', qualityController.getEmployees);
router.get('/warehouses', qualityController.getWarehouses);
router.post('/record', qualityController.createQualityRecord);
router.post('/save-qc-parameters', qualityController.saveQCParameters);

module.exports = router;