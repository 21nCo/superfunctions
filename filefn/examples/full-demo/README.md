# FileFn Full Demo

This project demonstrates the full capabilities of FileFn including:

- Client-side file uploading with `@filefn/client`
- Server-side file handling with `@filefn/server` (Hono adapter)
- Custom storage adapter (in-memory for demo)
- Processing integration (configured but using defaults)
- File listing and downloading

## Structure

- `server`: Node.js server using Hono
- `client`: SvelteKit application

## Running the Demo

1. **Install Dependencies**
   Run from the root of the workspace:

   ```bash
   npm install
   ```

2. **Start Server**
   Navigate to `examples/full-demo/server`:

   ```bash
   cd filefn/examples/full-demo/server
   npm run dev
   ```

   Server will start on `http://localhost:3000`.

3. **Start Client**
   Navigate to `examples/full-demo/client`:

   ```bash
   cd filefn/examples/full-demo/client
   npm run dev
   ```

   Client will start on `http://localhost:5173`.

4. **Verify**
   - Open `http://localhost:5173`
   - Upload a file (e.g., an image)
   - See it appear in the list
   - Click Download or Delete
