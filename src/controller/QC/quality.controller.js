const { sql, poolPromise } = require('../../database/connection');

exports.getQualityRecords = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    
    const countQuery = `SELECT COUNT(*) as total FROM DOME.dbo.[@XD_OQUL]`;
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    const dataQuery = `
      SELECT
          H.DocEntry AS [Document Entry],
          H.DocNum AS [Document Number],
          case when H.U_QCType = 'B' then 'Based on Document'
          else 'Standalone' end as [QC Type],
          case when H.U_Type = 'M' then 'Material' 
          else 'Process' end as [Type],
          H.U_RequestNo AS [Request Number],
          case when H.U_DocType = 20 then 'Goods Receipt PO'
          when H.U_DocType = 59 then 'Receipt From Production'
          when H.U_DocType = 16 then 'Sales Return'
          when H.U_DocType = 14 then 'A/R Credit Memo'
          end as [BaseType],
          H.U_BaseNum AS [Base Document No],
          H.U_CardCode AS [BP Code],
          H.U_CardName AS [BP Name],
          H.U_ItemCode AS [Item Code],
          H.U_ItemName AS [Item Name],
          H.U_SmpQty AS [Sample Qty],
          H.U_InsWhs AS [Inspection Warehouse],
          H.U_Supplier AS [Supplier Batch/Serial],
          H.U_BPLId AS [Branch],
          H.U_Series AS [Series],
          H.U_Line AS [Line No],
          H.U_Batch AS [Batch/Serial],
          H.U_ActualQty AS [Actual Quantity],
          H.U_Qty AS [Batch/Serial Quantity],
          H.U_ExpDate AS [Expiry Date],
          H.U_ReDate AS [Re-Test Date],
          H.U_InsITR AS [Inspection ITR],
          H.U_Manage AS [Managed By],
          H.U_SmpBy AS [Sample By],
          H.U_SmpByName AS [Sample By Name],
          H.U_InpBy AS [Inspected By],
          H.U_InpByName AS [Inspected By Name],
          H.U_AnlyzBy AS [Analyzed By],
          H.U_AnlyzByName AS [Analyzed By Name],
          H.U_RevBy AS [Reviewed By],
          H.U_RevByName AS [Reviewed By Name],
          H.U_RepBy AS [Report By],
          H.U_RepByName AS [Report By Name],
          H.U_QCDecision AS [QC Decision],
          H.U_AccpQty AS [Accepted Qty],
          H.U_RejQty AS [Rejected Qty],
          H.U_AcpWhs AS [Release Warehouse],
          H.U_RejWhs AS [Rejection Warehouse],
          H.U_AcpITR AS [Accepted ITR],
          H.U_RejITR AS [Rejected ITR],
          H.CreateDate AS [Create Date],
          H.UpdateDate AS [Update Date]
      FROM DOME.dbo.[@XD_OQUL] H
      ORDER BY H.DocEntry DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    const dataResult = await request.query(dataQuery);
    
    res.json({
      success: true,
      data: dataResult.recordset,
      pagination: {
        total, page, limit, pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error in getQualityRecords:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getQualityRecordDetails = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const pool = await poolPromise;
    const request = pool.request();
    request.input('DocEntry', sql.Int, parseInt(docEntry));

    const query = `
      SELECT
          H.DocEntry AS [Document Entry],
          H.DocNum AS [Document Number],
          case when H.U_QCType = 'B' then 'Based on Document'
          else 'Standalone' end as [QC Type],
          case when H.U_Type = 'M' then 'Material' 
          else 'Process' end as [Type],
          H.U_RequestNo AS [Request Number],
          case when H.U_DocType = 20 then 'Goods Receipt PO'
          when H.U_DocType = 59 then 'Receipt From Production'
          when H.U_DocType = 16 then 'Sales Return'
          when H.U_DocType = 14 then 'A/R Credit Memo'
          end as [BaseType],
          H.U_BaseNum AS [Base Document No],
          H.U_CardCode AS [BP Code],
          H.U_CardName AS [BP Name],
          H.U_ItemCode AS [Item Code],
          H.U_ItemName AS [Item Name],
          H.U_SmpQty AS [Sample Qty],
          H.U_InsWhs AS [Inspection Warehouse],
          H.U_Supplier AS [Supplier Batch/Serial],
          H.U_BPLId AS [Branch],
          H.U_Series AS [Series],
          H.U_Line AS [Line No],
          H.U_Batch AS [Batch/Serial],
          H.U_ActualQty AS [Actual Quantity],
          H.U_Qty AS [Batch/Serial Quantity],
          H.U_ExpDate AS [Expiry Date],
          H.U_ReDate AS [Re-Test Date],
          H.U_InsITR AS [Inspection ITR],
          H.U_Manage AS [Managed By],
          H.U_SmpBy AS [Sample By],
          H.U_SmpByName AS [Sample By Name],
          H.U_InpBy AS [Inspected By],
          H.U_InpByName AS [Inspected By Name],
          H.U_AnlyzBy AS [Analyzed By],
          H.U_AnlyzByName AS [Analyzed By Name],
          H.U_RevBy AS [Reviewed By],
          H.U_RevByName AS [Reviewed By Name],
          H.U_RepBy AS [Report By],
          H.U_RepByName AS [Report By Name],
          H.U_QCDecision AS [QC Decision],
          H.U_AccpQty AS [Accepted Qty],
          H.U_RejQty AS [Rejected Qty],
          H.U_AcpWhs AS [Release Warehouse],
          H.U_RejWhs AS [Rejection Warehouse],
          H.U_AcpITR AS [Accepted ITR],
          H.U_RejITR AS [Rejected ITR],
          H.CreateDate AS [Create Date],
          H.UpdateDate AS [Update Date],
          D.LineId AS [Parameter Line],
          D.U_PrmCode AS [Parameter Code],
          D.U_PrmName AS [Parameter Name],
          D.U_Action AS [Action],
          D.U_Criteria AS [Criteria],
          D.U_EqpCode AS [Equipment Code],
          D.U_EqpName AS [Equipment Name],
          D.U_Uom AS [UOM],
          D.U_StdValue AS [Std Value],
          D.U_MinValue AS [Min Value],
          D.U_MaxValue AS [Max Value],
          D.U_Type AS [Parameter Type],
          D.U_ObValue1 AS [Observed Value 1],
          D.U_ObValue2 AS [Observed Value 2],
          D.U_ObValue3 AS [Observed Value 3]
      FROM DOME.dbo.[@XD_OQUL] H
      LEFT JOIN DOME.dbo.[@XD_QUL1] D
          ON D.DocEntry = H.DocEntry
      WHERE H.DocEntry = @DocEntry
      ORDER BY D.LineId
    `;
    
    const dataResult = await request.query(query);
    
    if (dataResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Quality record not found' });
    }
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getQualityRecordDetails:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
