const express = require('express');
const router = express.Router();
const {
  listCOAReports,
  getUsedBatches,
  getCOAReport,
  saveCOAReport,
  updateCOAStatus
} = require('../../controller/QC/coaReport.controller');

router.get('/', listCOAReports);
router.get('/used-batches', getUsedBatches);
router.get('/:coaNo', getCOAReport);
router.post('/', saveCOAReport);
router.patch('/:coaNo/status', updateCOAStatus);

module.exports = router;
