const axios = require('axios');

async function test() {
  try {
    const res = await axios.post('http://localhost:6501/api/coa-template', {
      itemCode: "test_item_123",
      description: "[{\"test\":\"t\",\"specification\":\"s\",\"result\":\"r\"}]",
      createdBy: 1
    });
    console.log("Success:", res.data);
  } catch (err) {
    console.error("Error:", err.response ? err.response.data : err.message);
  }
}
test();
