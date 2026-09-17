const { poolPromise } = require('../../database/connection');

const getStaff = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT StaffID, Name, PhoneNumber, Address, Designation, WageSalary, CreatedDate, UpdatedDate, Status
      FROM Dome.dbo.PMSStaff
      ORDER BY StaffID DESC
    `;
    const result = await pool.request().query(query);
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error fetching staff:", error);
    res.status(500).json({ success: false, message: "Failed to fetch staff data" });
  }
};

const addStaff = async (req, res) => {
  try {
    const { name, phoneNumber, address, designation, wageSalary } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: "Name is required" });
    }

    const pool = await poolPromise;
    const query = `
      INSERT INTO Dome.dbo.PMSStaff (StaffID, Name, PhoneNumber, Address, Designation, WageSalary)
      VALUES (
        (SELECT ISNULL(MAX(StaffID), 0) + 1 FROM Dome.dbo.PMSStaff),
        @Name, 
        @PhoneNumber, 
        @Address, 
        @Designation, 
        @WageSalary
      )
    `;

    await pool.request()
      .input('Name', name)
      .input('PhoneNumber', phoneNumber || null)
      .input('Address', address || null)
      .input('Designation', designation || null)
      .input('WageSalary', wageSalary ? parseFloat(wageSalary) : null)
      .query(query);

    res.status(201).json({
      success: true,
      message: "Staff added successfully"
    });
  } catch (error) {
    console.error("Error adding staff:", error);
    res.status(500).json({ success: false, message: "Failed to add staff data" });
  }
};

const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phoneNumber, address, designation, wageSalary, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: "Name is required" });
    }

    const pool = await poolPromise;
    const query = `
      UPDATE Dome.dbo.PMSStaff 
      SET 
        Name = @Name, 
        PhoneNumber = @PhoneNumber, 
        Address = @Address, 
        Designation = @Designation, 
        WageSalary = @WageSalary,
        Status = @Status,
        UpdatedDate = GETDATE()
      WHERE StaffID = @StaffID
    `;

    await pool.request()
      .input('StaffID', id)
      .input('Name', name)
      .input('PhoneNumber', phoneNumber || null)
      .input('Address', address || null)
      .input('Designation', designation || null)
      .input('WageSalary', wageSalary ? parseFloat(wageSalary) : null)
      .input('Status', status === 1 || status === '1' || status === true || status === 'active' ? 1 : 0)
      .query(query);

    res.status(200).json({
      success: true,
      message: "Staff updated successfully"
    });
  } catch (error) {
    console.error("Error updating staff:", error);
    res.status(500).json({ success: false, message: "Failed to update staff data" });
  }
};

module.exports = {
  getStaff,
  addStaff,
  updateStaff
};
