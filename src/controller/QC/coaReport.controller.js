const { sql, poolPromise } = require('../../database/connection');

const mapHeader = (body, status) => ({
  DocNum: body.docNum ?? null,
  Status: status,
  FormNo: body.formNo || null,
  IssueDate: body.issueDate || null,
  ItemCode: body.itemCode || null,
  ItemName: body.itemName || null,
  ProductTop: body.productTop || null,
  ProductLine: body.productLine || null,
  Composition: body.composition || null,
  Product: body.product || null,
  CatNo: body.catNo || null,
  BatchNo: body.batchNo || body.batch || null,
  PackSize: body.packSize || null,
  BatchSize: body.batchSize || null,
  MfgDate: body.mfgDate || null,
  ExpDate: body.expDate || null,
  SopNo: body.sopNo || null,
  ProcessStage: body.processStage || null,
  RevisionNo: body.revisionNo || null,
  RegNo: body.regNo || body.reg || null,
  DateReported: body.dateReported || null,
  Remarks: body.remarks || null,
  AnalyzedByName: body.analyzedBy?.name || body.analyzedByName || null,
  AnalyzedByTitle: body.analyzedBy?.title || body.analyzedByTitle || null,
  AnalyzedByDate: body.analyzedBy?.date || body.analyzedByDate || null,
  CheckedByName: body.checkedBy?.name || body.checkedByName || null,
  CheckedByTitle: body.checkedBy?.title || body.checkedByTitle || null,
  CheckedByDate: body.checkedBy?.date || body.checkedByDate || null,
  ApprovedByName: body.approvedBy?.name || body.approvedByName || null,
  ApprovedByTitle: body.approvedBy?.title || body.approvedByTitle || null,
  ApprovedByDate: body.approvedBy?.date || body.approvedByDate || null,
});

const bindHeader = (request, header) => {
  Object.entries(header).forEach(([key, value]) => {
    request.input(key, value);
  });
  return request;
};

const replaceTests = async (transaction, coaNo, tests = []) => {
  await new sql.Request(transaction)
    .input('COA_No', sql.Int, coaNo)
    .query(`DELETE FROM DOME.dbo.PMSCOAReportTest WHERE COA_No = @COA_No`);

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i] || {};
    await new sql.Request(transaction)
      .input('COA_No', sql.Int, coaNo)
      .input('LineId', sql.Int, i + 1)
      .input('Tests', sql.NVarChar(sql.MAX), t.tests || t.test || null)
      .input('Specifications', sql.NVarChar(sql.MAX), t.specifications || t.specification || null)
      .input('AnalyzedBy', sql.NVarChar(100), t.analyzedBy || null)
      .input('Result', sql.NVarChar(500), t.result || null)
      .input('Conclusion', sql.NVarChar(500), t.conclusion || null)
      .query(`
        INSERT INTO DOME.dbo.PMSCOAReportTest
          (COA_No, LineId, Tests, Specifications, AnalyzedBy, Result, Conclusion)
        VALUES
          (@COA_No, @LineId, @Tests, @Specifications, @AnalyzedBy, @Result, @Conclusion)
      `);
  }
};

const listCOAReports = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();
    const productLine = (req.query.productLine || '').trim();
    const fromDate = (req.query.fromDate || '').trim();
    const toDate = (req.query.toDate || '').trim();
    const excludeStatus = (req.query.excludeStatus || '').trim();
    const statusIn = String(req.query.statusIn || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const conditions = [];

    const bindFilters = (request) => {
      if (search) {
        request.input('Search', sql.NVarChar, `%${search}%`);
        conditions.push(`(
          CAST(H.COA_No AS NVARCHAR(20)) LIKE @Search
          OR H.ItemCode LIKE @Search
          OR H.ItemName LIKE @Search
          OR H.BatchNo LIKE @Search
          OR H.CreatedByName LIKE @Search
        )`);
      }
      if (status) {
        request.input('Status', sql.NVarChar, status);
        conditions.push(`H.Status = @Status`);
      } else if (statusIn.length) {
        const names = statusIn.map((item, index) => {
          const key = `StatusIn${index}`;
          request.input(key, sql.NVarChar, item);
          return `@${key}`;
        });
        conditions.push(`H.Status IN (${names.join(', ')})`);
      }
      if (productLine) {
        request.input('ProductLine', sql.NVarChar, productLine);
        conditions.push(`LTRIM(RTRIM(H.ProductLine)) = @ProductLine`);
      }
      if (fromDate) {
        request.input('FromDate', sql.VarChar, fromDate);
        conditions.push(`CAST(H.CreatedAt AS DATE) >= @FromDate`);
      }
      if (toDate) {
        request.input('ToDate', sql.VarChar, toDate);
        conditions.push(`CAST(H.CreatedAt AS DATE) <= @ToDate`);
      }
      if (excludeStatus) {
        request.input('ExcludeStatus', sql.NVarChar, excludeStatus);
        conditions.push(`H.Status <> @ExcludeStatus`);
      }
    };

    const pool = await poolPromise;
    const countRequest = pool.request();
    bindFilters(countRequest);
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await countRequest.query(`
      SELECT COUNT(1) AS Total FROM DOME.dbo.PMSCOAReport H ${whereSql}
    `);
    const total = countResult.recordset[0]?.Total || 0;

    const dataRequest = pool.request();
    conditions.length = 0;
    bindFilters(dataRequest);
    const dataWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await dataRequest
      .input('Offset', sql.Int, offset)
      .input('Limit', sql.Int, limit)
      .query(`
        SELECT
          H.COA_No,
          H.DocNum,
          H.Status,
          H.FormNo,
          H.IssueDate,
          H.ItemCode,
          H.ItemName,
          H.ProductTop,
          H.ProductLine,
          H.Product,
          H.BatchNo,
          H.CreatedBy,
          H.CreatedByName,
          H.CreatedAt,
          H.UpdatedBy,
          H.UpdatedByName,
          H.UpdatedAt,
          H.GeneratedAt
        FROM DOME.dbo.PMSCOAReport H
        ${dataWhere}
        ORDER BY H.COA_No DESC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
      `);

    const optionsResult = await pool.request().query(`
      SELECT DISTINCT LTRIM(RTRIM(ProductLine)) AS ProductLine, Status
      FROM DOME.dbo.PMSCOAReport
    `);
    const productLines = [...new Set((optionsResult.recordset || []).map((row) => row.ProductLine).filter(Boolean))].sort();
    const statuses = [...new Set((optionsResult.recordset || []).map((row) => row.Status).filter(Boolean))].sort();

    res.json({
      success: true,
      data: result.recordset,
      productLines,
      statuses,
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit) || 1)
      }
    });
  } catch (error) {
    console.error('Error listing COA reports:', error);
    res.status(500).json({ success: false, message: 'Failed to list COA reports' });
  }
};

const getUsedBatches = async (req, res) => {
  try {
    const itemCode = (req.query.itemCode || '').trim();
    if (!itemCode) {
      return res.status(400).json({ success: false, message: 'itemCode is required' });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('ItemCode', sql.NVarChar(50), itemCode)
      .query(`
        SELECT DISTINCT BatchNo
        FROM DOME.dbo.PMSCOAReport
        WHERE ItemCode = @ItemCode
          AND ISNULL(BatchNo, '') <> ''
      `);

    res.json({
      success: true,
      data: result.recordset.map((row) => row.BatchNo)
    });
  } catch (error) {
    console.error('Error fetching used COA batches:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch used batches' });
  }
};

const getCOAReport = async (req, res) => {
  try {
    const coaNo = parseInt(req.params.coaNo, 10);
    if (!coaNo) {
      return res.status(400).json({ success: false, message: 'COA_No is required' });
    }

    const pool = await poolPromise;
    const headerResult = await pool.request()
      .input('COA_No', sql.Int, coaNo)
      .query(`SELECT * FROM DOME.dbo.PMSCOAReport WHERE COA_No = @COA_No`);

    if (!headerResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'COA report not found' });
    }

    const testsResult = await pool.request()
      .input('COA_No', sql.Int, coaNo)
      .query(`
        SELECT LineId, Tests, Specifications, AnalyzedBy, Result, Conclusion
        FROM DOME.dbo.PMSCOAReportTest
        WHERE COA_No = @COA_No
        ORDER BY LineId
      `);

    res.json({
      success: true,
      data: {
        ...headerResult.recordset[0],
        tests: testsResult.recordset
      }
    });
  } catch (error) {
    console.error('Error fetching COA report:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch COA report' });
  }
};

const saveCOAReport = async (req, res) => {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);

  try {
    const body = req.body || {};
    const status = body.status === 'Generated' || body.status === 'Pending' ? 'Pending' : 'Draft';
    const coaNoInput = body.coaNo ? parseInt(body.coaNo, 10) : null;
    const tests = Array.isArray(body.tests) ? body.tests : [];
    const userId = body.createdBy || body.updatedBy || 0;
    const userName = body.createdByName || body.updatedByName || null;
    const header = mapHeader(body, status);

    await transaction.begin();

    let coaNo = coaNoInput;
    const isUpdate = Boolean(coaNo);

    if (isUpdate) {
      const exists = await new sql.Request(transaction)
        .input('COA_No', sql.Int, coaNo)
        .query(`SELECT COA_No FROM DOME.dbo.PMSCOAReport WHERE COA_No = @COA_No`);

      if (!exists.recordset.length) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: 'COA report not found' });
      }

      const updateReq = new sql.Request(transaction)
        .input('COA_No', sql.Int, coaNo)
        .input('UpdatedBy', sql.Int, userId)
        .input('UpdatedByName', sql.NVarChar(100), userName);

      bindHeader(updateReq, header);

      await updateReq.query(`
        UPDATE DOME.dbo.PMSCOAReport SET
          DocNum = @DocNum,
          Status = @Status,
          FormNo = @FormNo,
          IssueDate = @IssueDate,
          ItemCode = @ItemCode,
          ItemName = @ItemName,
          ProductTop = @ProductTop,
          ProductLine = @ProductLine,
          Composition = @Composition,
          Product = @Product,
          CatNo = @CatNo,
          BatchNo = @BatchNo,
          PackSize = @PackSize,
          BatchSize = @BatchSize,
          MfgDate = @MfgDate,
          ExpDate = @ExpDate,
          SopNo = @SopNo,
          ProcessStage = @ProcessStage,
          RevisionNo = @RevisionNo,
          RegNo = @RegNo,
          DateReported = @DateReported,
          Remarks = @Remarks,
          AnalyzedByName = @AnalyzedByName,
          AnalyzedByTitle = @AnalyzedByTitle,
          AnalyzedByDate = @AnalyzedByDate,
          CheckedByName = @CheckedByName,
          CheckedByTitle = @CheckedByTitle,
          CheckedByDate = @CheckedByDate,
          ApprovedByName = @ApprovedByName,
          ApprovedByTitle = @ApprovedByTitle,
          ApprovedByDate = @ApprovedByDate,
          UpdatedBy = @UpdatedBy,
          UpdatedByName = @UpdatedByName,
          UpdatedAt = GETDATE(),
          GeneratedAt = CASE WHEN @Status = 'Pending' THEN ISNULL(GeneratedAt, GETDATE()) ELSE GeneratedAt END
        WHERE COA_No = @COA_No
      `);
    } else {
      const nextResult = await new sql.Request(transaction).query(`
        SELECT ISNULL(MAX(COA_No), 0) + 1 AS NextNo FROM DOME.dbo.PMSCOAReport
      `);
      coaNo = nextResult.recordset[0].NextNo;

      const insertReq = new sql.Request(transaction)
        .input('COA_No', sql.Int, coaNo)
        .input('CreatedBy', sql.Int, userId)
        .input('CreatedByName', sql.NVarChar(100), userName)
        .input('UpdatedBy', sql.Int, userId)
        .input('UpdatedByName', sql.NVarChar(100), userName);

      bindHeader(insertReq, header);

      await insertReq.query(`
        INSERT INTO DOME.dbo.PMSCOAReport (
          COA_No, DocNum, Status, FormNo, IssueDate, ItemCode, ItemName,
          ProductTop, ProductLine, Composition, Product, CatNo, BatchNo,
          PackSize, BatchSize, MfgDate, ExpDate, SopNo, ProcessStage,
          RevisionNo, RegNo, DateReported, Remarks,
          AnalyzedByName, AnalyzedByTitle, AnalyzedByDate,
          CheckedByName, CheckedByTitle, CheckedByDate,
          ApprovedByName, ApprovedByTitle, ApprovedByDate,
          CreatedBy, CreatedByName, CreatedAt, UpdatedBy, UpdatedByName, UpdatedAt, GeneratedAt
        ) VALUES (
          @COA_No, @DocNum, @Status, @FormNo, @IssueDate, @ItemCode, @ItemName,
          @ProductTop, @ProductLine, @Composition, @Product, @CatNo, @BatchNo,
          @PackSize, @BatchSize, @MfgDate, @ExpDate, @SopNo, @ProcessStage,
          @RevisionNo, @RegNo, @DateReported, @Remarks,
          @AnalyzedByName, @AnalyzedByTitle, @AnalyzedByDate,
          @CheckedByName, @CheckedByTitle, @CheckedByDate,
          @ApprovedByName, @ApprovedByTitle, @ApprovedByDate,
          @CreatedBy, @CreatedByName, GETDATE(), @UpdatedBy, @UpdatedByName, GETDATE(),
          CASE WHEN @Status = 'Pending' THEN GETDATE() ELSE NULL END
        )
      `);
    }

    await replaceTests(transaction, coaNo, tests);
    await transaction.commit();

    res.status(isUpdate ? 200 : 201).json({
      success: true,
      message: status === 'Pending' ? 'COA report generated successfully' : 'COA draft saved successfully',
      data: { coaNo, status }
    });
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    console.error('Error saving COA report:', error);
    res.status(500).json({ success: false, message: 'Failed to save COA report' });
  }
};

const updateCOAStatus = async (req, res) => {
  try {
    const coaNo = parseInt(req.params.coaNo, 10);
    const status = String(req.body?.status || '').trim();
    const allowed = ['Released', 'Hold', 'Reject'];
    if (!coaNo || !allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Released, Hold, or Reject' });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('COA_No', sql.Int, coaNo)
      .input('Status', sql.NVarChar(30), status)
      .input('UpdatedBy', sql.Int, req.body?.updatedBy || 0)
      .input('UpdatedByName', sql.NVarChar(100), req.body?.updatedByName || null)
      .query(`
        UPDATE DOME.dbo.PMSCOAReport
        SET Status = @Status,
            UpdatedBy = @UpdatedBy,
            UpdatedByName = @UpdatedByName,
            UpdatedAt = GETDATE()
        WHERE COA_No = @COA_No
          AND Status <> 'Draft'
      `);

    if (!result.rowsAffected?.[0]) {
      return res.status(404).json({ success: false, message: 'Certificate not found or still a draft' });
    }

    res.json({ success: true, message: `Status updated to ${status}`, data: { coaNo, status } });
  } catch (error) {
    console.error('Error updating COA status:', error);
    res.status(500).json({ success: false, message: 'Failed to update COA status' });
  }
};

module.exports = {
  listCOAReports,
  getUsedBatches,
  getCOAReport,
  saveCOAReport,
  updateCOAStatus
};
