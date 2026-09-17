const express = require('express');
const router = express.Router();
const { saveCOATemplate, getCOATemplate, getAllCOATemplates } = require('../../controller/QC/coaTemplate.controller');

router.post('/', saveCOATemplate);
router.get('/', getAllCOATemplates);
router.get('/:itemCode', getCOATemplate);

module.exports = router;
