const { sql, poolPromise } = require('../../database/connection');

const parseJson = (value, fallback) => {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const personJson = (value, name, title, date) => JSON.stringify({
  name: value?.name || name || null,
  title: value?.title || title || null,
  date: value?.date || date || null,
});

const mapHeader = (body, status) => {
  let extras = {};
  if (typeof body.formNo === 'string') extras = parseJson(body.formNo, {});
  return {
    Status: status,
    Header: JSON.stringify({
      docNum: body.docNum ?? null,
      formNo: body.formNo || null,
      issueDate: body.issueDate || null,
      itemCode: body.itemCode || null,
      itemName: body.itemName || null,
      productTop: body.productTop || null,
      productLine: body.productLine || null,
      composition: body.composition || null,
      product: body.product || null,
      catNo: body.catNo || null,
      batchNo: body.batchNo || body.batch || null,
      packSize: body.packSize || null,
      batchSize: body.batchSize || null,
      mfgDate: body.mfgDate || null,
      expDate: body.expDate || null,
      sopNo: body.sopNo || null,
      processStage: body.processStage || null,
      revisionNo: body.revisionNo || null,
      regNo: body.regNo || body.reg || null,
      dateReported: body.dateReported || null,
    }),
    Tests: JSON.stringify(Array.isArray(body.tests) ? body.tests.map((t, i) => ({
      LineId: i + 1,
      Tests: t.tests || t.test || t.Tests || null,
      Specifications: t.specifications || t.specification || t.Specifications || null,
      AnalyzedBy: t.analyzedBy || t.AnalyzedBy || null,
      Result: t.result || t.Result || null,
      Conclusion: t.conclusion || t.Conclusion || null,
    })) : []),
    StatementOfConformity: extras.conformity || body.conformity || null,
    Remarks: body.remarks || null,
    AnalyzedBy: personJson(body.analyzedBy, body.analyzedByName, body.analyzedByTitle, body.analyzedByDate),
    CheckedBy: personJson(body.checkedBy, body.checkedByName, body.checkedByTitle, body.checkedByDate),
    ApprovedBy: personJson(body.approvedBy, body.approvedByName, body.approvedByTitle, body.approvedByDate),
  };
};

const expandReport = (row) => {
  const header = parseJson(row.Header, {});
  const analyzed = parseJson(row.AnalyzedBy, {});
  const checked = parseJson(row.CheckedBy, {});
  const approved = parseJson(row.ApprovedBy, {});
  return {
    COA_No: row.COA_No,
    Status: row.Status,
    DocNum: header.docNum ?? null,
    FormNo: header.formNo ?? null,
    IssueDate: header.issueDate ?? null,
    ItemCode: header.itemCode ?? null,
    ItemName: header.itemName ?? null,
    ProductTop: header.productTop ?? null,
    ProductLine: header.productLine ?? null,
    Composition: header.composition ?? null,
    Product: header.product ?? null,
    CatNo: header.catNo ?? null,
    BatchNo: header.batchNo ?? null,
    PackSize: header.packSize ?? null,
    BatchSize: header.batchSize ?? null,
    MfgDate: header.mfgDate ?? null,
    ExpDate: header.expDate ?? null,
    SopNo: header.sopNo ?? null,
    ProcessStage: header.processStage ?? null,
    RevisionNo: header.revisionNo ?? null,
    RegNo: header.regNo ?? null,
    DateReported: header.dateReported ?? null,
    Remarks: row.Remarks,
    tests: parseStoredTests(row.Tests),
    AnalyzedByName: analyzed.name || null,
    AnalyzedByTitle: analyzed.title || null,
    AnalyzedByDate: analyzed.date || null,
    CheckedByName: checked.name || null,
    CheckedByTitle: checked.title || null,
    CheckedByDate: checked.date || null,
    ApprovedByName: approved.name || null,
    ApprovedByTitle: approved.title || null,
    ApprovedByDate: approved.date || null,
    CreatedBy: row.CreatedBy,
    CreatedByName: row.CreatedByName,
    CreatedAt: row.CreatedAt,
    UpdatedBy: row.UpdatedBy,
    UpdatedByName: row.UpdatedByName,
    UpdatedAt: row.UpdatedAt,
    GeneratedAt: row.GeneratedAt,
  };
};

const bindHeader = (request, header) => {
  Object.entries(header).forEach(([key, value]) => {
    request.input(key, value);
  });
  return request;
};

const parseStoredTests = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
          OR JSON_VALUE(H.Header, '$.itemCode') LIKE @Search
          OR JSON_VALUE(H.Header, '$.itemName') LIKE @Search
          OR JSON_VALUE(H.Header, '$.batchNo') LIKE @Search
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
        conditions.push(`LTRIM(RTRIM(JSON_VALUE(H.Header, '$.productLine'))) = @ProductLine`);
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
          JSON_VALUE(H.Header, '$.docNum') AS DocNum,
          H.Status,
          JSON_VALUE(H.Header, '$.formNo') AS FormNo,
          JSON_VALUE(H.Header, '$.issueDate') AS IssueDate,
          JSON_VALUE(H.Header, '$.itemCode') AS ItemCode,
          JSON_VALUE(H.Header, '$.itemName') AS ItemName,
          JSON_VALUE(H.Header, '$.productTop') AS ProductTop,
          JSON_VALUE(H.Header, '$.productLine') AS ProductLine,
          JSON_VALUE(H.Header, '$.product') AS Product,
          JSON_VALUE(H.Header, '$.batchNo') AS BatchNo,
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
      SELECT DISTINCT LTRIM(RTRIM(JSON_VALUE(Header, '$.productLine'))) AS ProductLine, Status
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
        SELECT DISTINCT JSON_VALUE(Header, '$.batchNo') AS BatchNo
        FROM DOME.dbo.PMSCOAReport
        WHERE JSON_VALUE(Header, '$.itemCode') = @ItemCode
          AND ISNULL(JSON_VALUE(Header, '$.batchNo'), '') <> ''
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

    res.json({
      success: true,
      data: expandReport(headerResult.recordset[0])
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
    const status = body.status === 'Generated' || body.status === 'Pending'
      ? 'Pending'
      : body.status === 'Hold'
        ? 'Hold'
        : 'Draft';
    const coaNoInput = body.coaNo ? parseInt(body.coaNo, 10) : null;
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
          Status = @Status,
          Header = @Header,
          Tests = @Tests,
          StatementOfConformity = @StatementOfConformity,
          Remarks = @Remarks,
          AnalyzedBy = @AnalyzedBy,
          CheckedBy = @CheckedBy,
          ApprovedBy = @ApprovedBy,
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
          COA_No, Status, Header, Tests, StatementOfConformity, Remarks,
          AnalyzedBy, CheckedBy, ApprovedBy,
          CreatedBy, CreatedByName, CreatedAt, UpdatedBy, UpdatedByName, UpdatedAt, GeneratedAt
        ) VALUES (
          @COA_No, @Status, @Header, @Tests, @StatementOfConformity, @Remarks,
          @AnalyzedBy, @CheckedBy, @ApprovedBy,
          @CreatedBy, @CreatedByName, GETDATE(), @UpdatedBy, @UpdatedByName, GETDATE(),
          CASE WHEN @Status = 'Pending' THEN GETDATE() ELSE NULL END
        )
      `);
    }

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
