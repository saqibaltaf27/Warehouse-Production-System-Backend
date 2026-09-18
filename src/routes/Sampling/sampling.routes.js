const express = require('express');
const router = express.Router();
const samplingController = require('../../controller/Sampling/sampling.controller');

router.get('/qc-rm', samplingController.getQCRmList);
router.get('/open-documents', samplingController.getOpenDocuments);
router.get('/document-details', samplingController.getDocumentDetails);
router.get('/next-qc-number', samplingController.getNextQcNumber);
router.get('/saved-samples', samplingController.getSavedSamples);
router.get('/saved-sample/:docnum', samplingController.getSavedSampleDetails);
router.post('/save', samplingController.saveSample);
router.get('/filtered', samplingController.getFilteredSamples);

module.exports = router;
