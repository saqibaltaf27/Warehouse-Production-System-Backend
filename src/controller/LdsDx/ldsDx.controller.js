const { sql, poolPromise } = require("../../database/connection");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fiscalStartYear(date = new Date()) {
  return date.getMonth() >= 6 ? date.getFullYear() : date.getFullYear() - 1;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dxSegmentSql(itemAlias = "I") {
  return `
    CASE
      WHEN (
        ${itemAlias}.U_cat1 LIKE N'%Finished Product%'
        AND (
          ${itemAlias}.ItemName NOT LIKE N'%ohex%'
          AND ${itemAlias}.ItemName NOT LIKE N'%Bioshoot%'
          AND ${itemAlias}.ItemName NOT LIKE N'%Injection%'
          OR ${itemAlias}.ItemName LIKE N'%test%'
        )
      ) THEN N'LDS Dx'
      ELSE N'LDS Pharma'
    END
  `;
}

function salesSourceSql() {
  return `
    (
      SELECT
        D.DocDate,
        (CASE WHEN MONTH(D.DocDate) < 7 THEN CONCAT('H2-', YEAR(D.DocDate) - 1, '/', YEAR(D.DocDate)) ELSE CONCAT('H1-', YEAR(D.DocDate), '/', YEAR(D.DocDate) + 1) END) AS Period,
        (CASE WHEN MONTH(D.DocDate) < 7 THEN CONCAT('FY-', YEAR(D.DocDate) - 1, '/', YEAR(D.DocDate)) ELSE CONCAT('FY-', YEAR(D.DocDate), '/', YEAR(D.DocDate) + 1) END) AS FYears,
        (CASE WHEN MONTH(D.DocDate) IN (1,2,3) THEN 'Qtr3' WHEN MONTH(D.DocDate) IN (4,5,6) THEN 'Qtr4' WHEN MONTH(D.DocDate) IN (7,8,9) THEN 'Qtr1' ELSE 'Qtr2' END) AS Qtrs,
        D.DocNum AS InvDocNum,
        D.CardCode,
        C.CardName,
        G.GroupName,
        C.City,
        C.U_Region AS Zone,
        DL.ItemCode,
        I.ItemName AS Item,
        I.U_cat1 AS Cat,
        I.CardCode AS PrincipalCode,
        I.U_cat1 AS [Product Family],
        CAST(DL.Quantity AS FLOAT) AS Quantity,
        ${dxSegmentSql("I")} AS [Product Segment 2025]
      FROM LDS_LIVE.dbo.INV1 DL WITH (NOLOCK)
      INNER JOIN LDS_LIVE.dbo.OINV D WITH (NOLOCK) ON DL.DocEntry = D.DocEntry
      INNER JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON I.ItemCode = DL.ItemCode
      INNER JOIN LDS_LIVE.dbo.OCRD C WITH (NOLOCK) ON C.CardCode = D.CardCode
      LEFT JOIN LDS_LIVE.dbo.OCRG G WITH (NOLOCK) ON G.GroupCode = C.GroupCode
      WHERE D.CANCELED = 'N'
        AND D.DocType = 'I'
        AND CAST(D.DocDate AS date) >= @FromDate
        AND CAST(D.DocDate AS date) <= @ToDate
      UNION ALL
      SELECT
        S.DocDate,
        (CASE WHEN MONTH(S.DocDate) < 7 THEN CONCAT('H2-', YEAR(S.DocDate) - 1, '/', YEAR(S.DocDate)) ELSE CONCAT('H1-', YEAR(S.DocDate), '/', YEAR(S.DocDate) + 1) END) AS Period,
        (CASE WHEN MONTH(S.DocDate) < 7 THEN CONCAT('FY-', YEAR(S.DocDate) - 1, '/', YEAR(S.DocDate)) ELSE CONCAT('FY-', YEAR(S.DocDate), '/', YEAR(S.DocDate) + 1) END) AS FYears,
        (CASE WHEN MONTH(S.DocDate) IN (1,2,3) THEN 'Qtr3' WHEN MONTH(S.DocDate) IN (4,5,6) THEN 'Qtr4' WHEN MONTH(S.DocDate) IN (7,8,9) THEN 'Qtr1' ELSE 'Qtr2' END) AS Qtrs,
        S.DocNum AS InvDocNum,
        S.CardCode,
        C.CardName,
        G.GroupName,
        C.City,
        C.U_Region AS Zone,
        R.ItemCode,
        I.ItemName AS Item,
        I.U_cat1 AS Cat,
        I.CardCode AS PrincipalCode,
        I.U_cat1 AS [Product Family],
        CAST(R.Quantity AS FLOAT) * -1 AS Quantity,
        ${dxSegmentSql("I")} AS [Product Segment 2025]
      FROM LDS_LIVE.dbo.RIN1 R WITH (NOLOCK)
      INNER JOIN LDS_LIVE.dbo.ORIN S WITH (NOLOCK) ON S.DocEntry = R.DocEntry
      INNER JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON I.ItemCode = R.ItemCode
      INNER JOIN LDS_LIVE.dbo.OCRD C WITH (NOLOCK) ON C.CardCode = S.CardCode
      LEFT JOIN LDS_LIVE.dbo.OCRG G WITH (NOLOCK) ON G.GroupCode = C.GroupCode
      WHERE S.CANCELED = 'N'
        AND S.DocType = 'I'
        AND CAST(S.DocDate AS date) >= @FromDate
        AND CAST(S.DocDate AS date) <= @ToDate
    )
  `;
}

function monthSlots(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  const slots = [];
  let year = from.getFullYear();
  let month = from.getMonth();
  while (year < to.getFullYear() || (year === to.getFullYear() && month <= to.getMonth())) {
    slots.push({
      periodKey: `${year}-${String(month + 1).padStart(2, "0")}`,
      monthName: `${MONTH_NAMES[month]} ${year}`,
    });
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return slots;
}

exports.getDashboard = async (req, res) => {
  try {
    const today = isoDate(new Date());
    const fy = fiscalStartYear();
    let fromDate = String(req.query.fromDate || `${fy}-07-01`).slice(0, 10);
    let toDate = String(req.query.toDate || today).slice(0, 10);
    if (fromDate > toDate) {
      const swap = fromDate;
      fromDate = toDate;
      toDate = swap;
    }

    const pool = await poolPromise;
    const salesRequest = pool.request();
    salesRequest.input("FromDate", sql.Date, fromDate);
    salesRequest.input("ToDate", sql.Date, toDate);

    const salesSql = `
      SELECT
        YEAR(DocDate) AS SalesYear,
        MONTH(DocDate) AS SalesMonthNumber,
        CardCode,
        CardName,
        ItemCode,
        Item AS ItemName,
        SUM(Quantity) AS TotalQty
      FROM ${salesSourceSql()} SalesSrc
      WHERE [Product Segment 2025] = N'LDS Dx'
      GROUP BY YEAR(DocDate), MONTH(DocDate), CardCode, CardName, ItemCode, Item
    `;

    const ordersSql = `
      SELECT
        H.DocNum AS SalesOrderNumber,
        CONVERT(varchar(10), H.DocDate, 23) AS OrderDate,
        CONVERT(varchar(10), H.DocDueDate, 23) AS DeliveryDate,
        H.CardCode,
        H.CardName AS CustomerName,
        L.ItemCode,
        L.Dscription AS ItemName,
        L.Quantity AS OrderedQty,
        ISNULL(STK.OnHandQty, 0) AS OnHandQty
      FROM LDS_LIVE.dbo.ORDR H WITH (NOLOCK)
      INNER JOIN LDS_LIVE.dbo.RDR1 L WITH (NOLOCK) ON H.DocEntry = L.DocEntry
      INNER JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON I.ItemCode = L.ItemCode
      LEFT JOIN (
        SELECT W.ItemCode, SUM(W.OnHand) AS OnHandQty
        FROM LDS_LIVE.dbo.OITM M WITH (NOLOCK)
        INNER JOIN LDS_LIVE.dbo.OITW W WITH (NOLOCK) ON M.ItemCode = W.ItemCode
        WHERE M.InvntItem = 'Y'
          AND W.OnHand > 0
        GROUP BY W.ItemCode
      ) STK ON STK.ItemCode = L.ItemCode
      WHERE H.DocStatus = 'O'
        AND H.CANCELED = 'N'
        AND L.LineStatus = 'O'
        AND L.OpenQty > 0
        AND (${dxSegmentSql("I")}) = N'LDS Dx'
      ORDER BY H.DocDueDate, H.DocNum
    `;

    const [salesResult, ordersResult] = await Promise.all([
      salesRequest.query(salesSql),
      pool.request().query(ordersSql),
    ]);

    const salesRows = salesResult.recordset || [];
    const customers = new Map();
    const items = new Map();
    const customerMonth = new Map();
    const itemMonth = new Map();
    const totalMonth = new Map();

    salesRows.forEach((row) => {
      const qty = toNumber(row.TotalQty);
      const periodKey = `${row.SalesYear}-${String(row.SalesMonthNumber).padStart(2, "0")}`;
      customers.set(row.CardCode, row.CardName || row.CardCode);
      items.set(row.ItemCode, row.ItemName || row.ItemCode);
      totalMonth.set(periodKey, (totalMonth.get(periodKey) || 0) + qty);

      if (!customerMonth.has(row.CardCode)) customerMonth.set(row.CardCode, new Map());
      const cm = customerMonth.get(row.CardCode);
      cm.set(periodKey, (cm.get(periodKey) || 0) + qty);

      if (!itemMonth.has(row.ItemCode)) itemMonth.set(row.ItemCode, new Map());
      const im = itemMonth.get(row.ItemCode);
      im.set(periodKey, (im.get(periodKey) || 0) + qty);
    });

    const slots = monthSlots(fromDate, toDate);
    const monthlyTrend = slots.map((slot) => {
      const row = {
        periodKey: slot.periodKey,
        monthName: slot.monthName,
        totalQty: totalMonth.get(slot.periodKey) || 0,
      };
      customerMonth.forEach((months, cardCode) => {
        row[`c:${cardCode}`] = months.get(slot.periodKey) || 0;
      });
      itemMonth.forEach((months, itemCode) => {
        row[`i:${itemCode}`] = months.get(slot.periodKey) || 0;
      });
      return row;
    });

    const orders = (ordersResult.recordset || []).map((row) => ({
      ...row,
      OrderedQty: toNumber(row.OrderedQty),
      OnHandQty: toNumber(row.OnHandQty),
    }));

    return res.json({
      success: true,
      data: {
        range: { fromDate, toDate },
        customers: Array.from(customers.entries())
          .map(([cardCode, cardName]) => ({ cardCode, cardName }))
          .sort((a, b) => a.cardCode.localeCompare(b.cardCode)),
        items: Array.from(items.entries())
          .map(([itemCode, itemName]) => ({ itemCode, itemName }))
          .sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
        monthlyTrend,
        salesPoints: salesRows.map((row) => ({
          periodKey: `${row.SalesYear}-${String(row.SalesMonthNumber).padStart(2, "0")}`,
          cardCode: row.CardCode,
          itemCode: row.ItemCode,
          qty: toNumber(row.TotalQty),
        })),
        orders,
      },
    });
  } catch (err) {
    console.error("lds-dx dashboard:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
