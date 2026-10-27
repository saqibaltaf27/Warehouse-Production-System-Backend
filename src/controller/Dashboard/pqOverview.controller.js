const { sql, poolPromise } = require('../../database/connection');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const monthBounds = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { startDate: iso(start), endDate: iso(end) };
};

const parseRange = (query) => {
  const defaults = monthBounds();
  const startDate = String(query.startDate || defaults.startDate).slice(0, 10);
  const endDate = String(query.endDate || defaults.endDate).slice(0, 10);
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { error: 'Start date and end date must use YYYY-MM-DD' };
  }
  if (startDate > endDate) {
    return { error: 'Start date must be on or before end date' };
  }
  return { startDate, endDate };
};

const n = (value) => Number(value) || 0;
const pct = (part, total) => (total > 0 ? Number(((part / total) * 100).toFixed(1)) : 0);

exports.getPqOverview = async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) {
    return res.status(400).json({ success: false, message: range.error });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request();
    request.input('StartDate', sql.Date, range.startDate);
    request.input('EndDate', sql.Date, range.endDate);

    const result = await request.query(`
      -- Production: OWOR.PostDate in range. Status P=Planned, R=Released, L=Closed, C=Cancelled.
      -- Delayed = open (P/R), due before today, completed qty below planned qty.
      SELECT
        COUNT(*) AS TotalOrders,
        SUM(CASE WHEN Status = 'P' THEN 1 ELSE 0 END) AS PlannedOrders,
        SUM(CASE WHEN Status = 'R' THEN 1 ELSE 0 END) AS ReleasedOrders,
        SUM(CASE WHEN Status = 'L' THEN 1 ELSE 0 END) AS CompletedOrders,
        SUM(CASE WHEN Status IN ('P', 'R') AND DueDate < CAST(GETDATE() AS DATE) AND ISNULL(CmpltQty, 0) < ISNULL(PlannedQty, 0) THEN 1 ELSE 0 END) AS DelayedOrders,
        ISNULL(SUM(PlannedQty), 0) AS PlannedQty,
        ISNULL(SUM(CmpltQty), 0) AS ActualQty
      FROM LDS_LIVE.dbo.OWOR
      WHERE Status <> 'C'
        AND CAST(PostDate AS DATE) BETWEEN @StartDate AND @EndDate;

      SELECT
        ISNULL(SUM(CASE WHEN Status = 'P' THEN PlannedQty ELSE 0 END), 0) AS PlannedQty,
        ISNULL(SUM(CASE WHEN Status = 'R' THEN PlannedQty ELSE 0 END), 0) AS ReleasedQty,
        ISNULL(SUM(CASE WHEN Status = 'L' THEN PlannedQty ELSE 0 END), 0) AS CompletedPlannedQty,
        ISNULL(SUM(CmpltQty), 0) AS ActualQty
      FROM LDS_LIVE.dbo.OWOR
      WHERE Status <> 'C'
        AND CAST(PostDate AS DATE) BETWEEN @StartDate AND @EndDate;

      -- QA: sample lines in LDS_LIVE [@XD_SMP1], dated by header U_SmpDate.
      -- S/PR/blank = pending, UI = on hold, A/CA = approved, R/CR = rejected.
      SELECT
        COUNT(DISTINCT CONCAT(ISNULL(NULLIF(L.U_Batch, ''), 'LINE'), '-', L.DocEntry, '-', L.LineId)) AS TotalBatches,
        COUNT(DISTINCT CASE WHEN L.U_Status IN ('A', 'CA') THEN CONCAT(ISNULL(NULLIF(L.U_Batch, ''), 'LINE'), '-', L.DocEntry, '-', L.LineId) END) AS ApprovedBatches,
        COUNT(DISTINCT CASE WHEN L.U_Status IN ('S', 'PR') OR L.U_Status IS NULL OR L.U_Status = '' THEN CONCAT(ISNULL(NULLIF(L.U_Batch, ''), 'LINE'), '-', L.DocEntry, '-', L.LineId) END) AS PendingBatches,
        COUNT(DISTINCT CASE WHEN L.U_Status = 'UI' THEN CONCAT(ISNULL(NULLIF(L.U_Batch, ''), 'LINE'), '-', L.DocEntry, '-', L.LineId) END) AS HoldBatches,
        COUNT(DISTINCT CASE WHEN L.U_Status IN ('R', 'CR') THEN CONCAT(ISNULL(NULLIF(L.U_Batch, ''), 'LINE'), '-', L.DocEntry, '-', L.LineId) END) AS RejectedBatches
      FROM LDS_LIVE.dbo.[@XD_SMP1] L
      INNER JOIN LDS_LIVE.dbo.[@XD_OSMP] H ON H.DocEntry = L.DocEntry
      WHERE ISNULL(H.Canceled, 'N') = 'N'
        AND CAST(ISNULL(H.U_SmpDate, H.CreateDate) AS DATE) BETWEEN @StartDate AND @EndDate;

      SELECT
        ISNULL(L.U_Status, 'Pending') AS StatusCode,
        COUNT(*) AS LineCount
      FROM LDS_LIVE.dbo.[@XD_SMP1] L
      INNER JOIN LDS_LIVE.dbo.[@XD_OSMP] H ON H.DocEntry = L.DocEntry
      WHERE ISNULL(H.Canceled, 'N') = 'N'
        AND CAST(ISNULL(H.U_SmpDate, H.CreateDate) AS DATE) BETWEEN @StartDate AND @EndDate
      GROUP BY ISNULL(L.U_Status, 'Pending');

      -- QC: inspection headers in LDS_LIVE [@XD_OQUL]. CreateDate is the inspection date (U_ReDate is unused).
      -- A/CA = passed, R/CR = failed, blank = pending.
      SELECT
        COUNT(*) AS TotalInspections,
        SUM(CASE WHEN U_QCDecision IN ('A', 'CA') THEN 1 ELSE 0 END) AS PassedInspections,
        SUM(CASE WHEN U_QCDecision IN ('R', 'CR') THEN 1 ELSE 0 END) AS FailedInspections,
        SUM(CASE WHEN U_QCDecision IS NULL OR U_QCDecision = '' THEN 1 ELSE 0 END) AS PendingInspections,
        COUNT(DISTINCT CASE WHEN U_QCDecision IS NULL OR U_QCDecision = '' THEN ISNULL(NULLIF(U_Batch, ''), CAST(DocEntry AS nvarchar(20))) END) AS BatchesAwaiting
      FROM LDS_LIVE.dbo.[@XD_OQUL]
      WHERE ISNULL(Canceled, 'N') = 'N'
        AND CAST(CreateDate AS DATE) BETWEEN @StartDate AND @EndDate;

      -- Purchase orders: OPOR/POR1, not production orders.
      SELECT
        COUNT(DISTINCT H.DocEntry) AS OpenPurchaseOrders,
        ISNULL(SUM(L.OpenQty), 0) AS PendingPoQty
      FROM LDS_LIVE.dbo.OPOR H
      INNER JOIN LDS_LIVE.dbo.POR1 L ON L.DocEntry = H.DocEntry
      WHERE H.CANCELED = 'N'
        AND H.DocStatus = 'O'
        AND L.LineStatus = 'O'
        AND CAST(H.DocDate AS DATE) BETWEEN @StartDate AND @EndDate;

      -- Shortages on open production orders posted in range: remaining component qty above warehouse OnHand.
      SELECT
        SUM(CASE WHEN ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0) > ISNULL(I.OnHand, 0) THEN 1 ELSE 0 END) AS ShortageLines,
        COUNT(DISTINCT CASE WHEN ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0) > ISNULL(I.OnHand, 0) THEN O.DocEntry END) AS ShortageOrders,
        SUM(CASE WHEN ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0) <= ISNULL(I.OnHand, 0) THEN 1 ELSE 0 END) AS CoveredLines
      FROM LDS_LIVE.dbo.WOR1 W
      INNER JOIN LDS_LIVE.dbo.OWOR O ON O.DocEntry = W.DocEntry
      LEFT JOIN LDS_LIVE.dbo.OITW I ON I.ItemCode = W.ItemCode AND I.WhsCode = W.wareHouse
      WHERE O.Status IN ('P', 'R')
        AND ISNULL(W.ItemType, 4) = 4
        AND CAST(O.PostDate AS DATE) BETWEEN @StartDate AND @EndDate;
    `);

    const production = result.recordsets[0][0] || {};
    const qtySplit = result.recordsets[1][0] || {};
    const qa = result.recordsets[2][0] || {};
    const qaBreakdown = result.recordsets[3] || [];
    const qc = result.recordsets[4][0] || {};
    const purchasing = result.recordsets[5][0] || {};
    const materials = result.recordsets[6][0] || {};

    const plannedQty = n(production.PlannedQty);
    const actualQty = n(production.ActualQty);
    const qaTotal = n(qa.TotalBatches);
    const qaApproved = n(qa.ApprovedBatches);
    const qcTotal = n(qc.TotalInspections);
    const qcPassed = n(qc.PassedInspections);
    const shortageLines = n(materials.ShortageLines);
    const coveredLines = n(materials.CoveredLines);

    res.json({
      success: true,
      data: {
        range,
        refreshedAt: new Date().toISOString(),
        production: {
          totalOrders: n(production.TotalOrders),
          plannedOrders: n(production.PlannedOrders),
          releasedOrders: n(production.ReleasedOrders),
          completedOrders: n(production.CompletedOrders),
          delayedOrders: n(production.DelayedOrders),
          plannedQty,
          actualQty,
          plannedVsActualPct: pct(actualQty, plannedQty),
          statusChart: [
            { name: 'Planned', value: n(production.PlannedOrders) },
            { name: 'In Progress', value: n(production.ReleasedOrders) },
            { name: 'Completed', value: n(production.CompletedOrders) },
            { name: 'Delayed', value: n(production.DelayedOrders) },
          ],
          planActualChart: [
            { name: 'Planned', value: plannedQty },
            { name: 'Actual', value: actualQty },
          ],
          qtySplit,
        },
        qa: {
          totalBatches: qaTotal,
          approvedBatches: qaApproved,
          pendingBatches: n(qa.PendingBatches),
          holdBatches: n(qa.HoldBatches),
          rejectedBatches: n(qa.RejectedBatches),
          approvalRate: pct(qaApproved, qaTotal),
          breakdown: qaBreakdown.map((row) => ({
            name: row.StatusCode,
            value: n(row.LineCount),
          })),
        },
        qc: {
          totalInspections: qcTotal,
          passedInspections: qcPassed,
          failedInspections: n(qc.FailedInspections),
          pendingInspections: n(qc.PendingInspections),
          passRate: pct(qcPassed, qcTotal),
          batchesAwaiting: n(qc.BatchesAwaiting),
          resultChart: [
            { name: 'Passed', value: qcPassed },
            { name: 'Failed', value: n(qc.FailedInspections) },
            { name: 'Pending', value: n(qc.PendingInspections) },
          ],
        },
        materials: {
          openPurchaseOrders: n(purchasing.OpenPurchaseOrders),
          pendingPoQty: n(purchasing.PendingPoQty),
          shortageOrders: n(materials.ShortageOrders),
          shortageLines,
          coveredLines,
          availability: shortageLines > 0 ? 'Constrained' : 'Available',
        },
        alerts: {
          overdueProductionOrders: n(production.DelayedOrders),
          materialShortages: n(materials.ShortageOrders),
          qaApprovalsPending: n(qa.PendingBatches) + n(qa.HoldBatches),
          qcInspectionsPending: n(qc.PendingInspections),
          rejectedOrHeldBatches: n(qa.RejectedBatches) + n(qa.HoldBatches),
        },
        definitions: {
          productionDate: 'OWOR.PostDate',
          planned: "OWOR.Status = 'P'",
          inProgress: "OWOR.Status = 'R' (Released)",
          completed: "OWOR.Status = 'L' (Closed)",
          delayed: 'Open P/R orders with DueDate before today and CmpltQty < PlannedQty',
          actualQty: 'OWOR.CmpltQty',
          qaDate: '[@XD_OSMP].U_SmpDate, else CreateDate',
          qaSource: 'LDS_LIVE.dbo.[@XD_SMP1].U_Status',
          qcDate: '[@XD_OQUL].CreateDate',
          qcSource: 'LDS_LIVE.dbo.[@XD_OQUL].U_QCDecision',
          purchaseOrders: 'OPOR/POR1 open documents (not OWOR)',
          shortages: 'Open OWOR components in WOR1 where remaining qty exceeds OITW.OnHand',
        },
        notes: [
          'Cancelled production orders (OWOR.Status = C) are excluded from production totals.',
          'QA uses sample line status in LDS_LIVE [@XD_SMP1]. Header [@XD_OSMP].U_Status is not populated.',
          'QC uses inspection decisions in LDS_LIVE [@XD_OQUL]. SAP OQAG is an authorization group table and is not used as QA/QC evidence.',
          'Production order closure is not treated as QA or QC approval.',
        ],
      },
    });
  } catch (err) {
    console.error('Error in getPqOverview:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
