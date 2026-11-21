const express = require('express');
const router = express.Router();
const { saveCOATemplate, getCOATemplate, getCOATemplateByLine, getAllCOATemplates } = require('../../controller/QC/coaTemplate.controller');

router.post('/', saveCOATemplate);
router.get('/', getAllCOATemplates);
router.get('/by-line', getCOATemplateByLine);
router.get('/:itemCode', getCOATemplate);

module.exports = router;
