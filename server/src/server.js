'use strict';
require('./db').db();
const app = require('./app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`meeting-minutes editor listening on http://localhost:${port}`));
