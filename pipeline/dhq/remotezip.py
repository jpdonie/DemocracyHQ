"""Read individual members of a large remote ZIP using HTTP range requests.

Official bulk archives (California ``pubinfo_YYYY.zip`` is ~1.3 GB, Census
P.L. 94-171 state files are 10-80 MB each) contain far more than the pipeline
needs. ``zipfile`` only needs random access to the central directory and to the
members it opens, so a seekable file object backed by ranged GETs lets us read
a few megabytes instead of the whole archive.
"""

from __future__ import annotations

import io
import struct
import zipfile
import zlib
from typing import Dict, Iterator, Optional

from .http import FetchError, Fetcher

#: Largest member :meth:`RemoteZip.read` inflates, unless the caller sets its own limit. The largest member read
#: whole today is a California history table of about 18 MB; the Census members read whole are a few MB each.
MAX_MEMBER_BYTES = 256 * 1024 * 1024
#: Largest member :meth:`RemoteZip.member_bytes` fetches, unless the caller sets its own limit. It reads one bill
#: version's XML; the largest seen so far is under 1 MB.
MAX_TEXT_MEMBER_BYTES = 64 * 1024 * 1024
#: Longest line :meth:`RemoteZip.lines` returns. The Census and California tables have lines of a few KB at most.
MAX_LINE_BYTES = 1024 * 1024


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file object over HTTP ``Range`` requests.

    Blocks are cached so the many small reads ``zipfile`` performs on the
    central directory cost a handful of requests.
    """

    def __init__(self, url: str, fetcher: Fetcher, *, block_size: int = 4 * 1024 * 1024):
        super().__init__()
        self.url = url
        self.fetcher = fetcher
        self.block_size = block_size
        headers = fetcher.head(url)
        if headers.get("Accept-Ranges", "").lower() != "bytes":
            raise FetchError(url, 200, "server does not advertise byte ranges")
        self.size = int(headers["Content-Length"])
        self.last_modified: Optional[str] = headers.get("Last-Modified")
        self.etag: Optional[str] = headers.get("ETag")
        self._pos = 0
        self._blocks: Dict[int, bytes] = {}
        self.bytes_fetched = 0

    # -- io.RawIOBase interface -------------------------------------------------
    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self._pos = offset
        elif whence == io.SEEK_CUR:
            self._pos += offset
        elif whence == io.SEEK_END:
            self._pos = self.size + offset
        else:  # pragma: no cover - defensive
            raise ValueError("invalid whence")
        self._pos = max(0, min(self._pos, self.size))
        return self._pos

    def _block(self, index: int) -> bytes:
        cached = self._blocks.get(index)
        if cached is not None:
            return cached
        start = index * self.block_size
        end = min(start + self.block_size, self.size) - 1
        # The size is checked too: a file replaced on the server mid-read would mix two versions.
        result = self.fetcher.get_range(self.url, start, end, total=self.size)
        self.bytes_fetched += len(result.content)
        # Keep memory bounded: the central directory blocks stay hot, data
        # blocks are read sequentially so a small cache is enough.
        if len(self._blocks) >= 24:
            self._blocks.pop(next(iter(self._blocks)))
        self._blocks[index] = result.content
        return result.content

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = self.size - self._pos
        size = min(size, self.size - self._pos)
        if size <= 0:
            return b""
        out = bytearray()
        while size > 0:
            index, offset = divmod(self._pos, self.block_size)
            chunk = self._block(index)[offset : offset + size]
            if not chunk:
                break
            out += chunk
            self._pos += len(chunk)
            size -= len(chunk)
        return bytes(out)

    def readinto(self, b) -> int:  # type: ignore[override]
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


class RemoteZip:
    """``zipfile.ZipFile`` over :class:`HttpRangeFile` with small helpers."""

    def __init__(self, url: str, fetcher: Fetcher, *, block_size: int = 4 * 1024 * 1024):
        self.url = url
        self.raw = HttpRangeFile(url, fetcher, block_size=block_size)
        self.zip = zipfile.ZipFile(io.BufferedReader(self.raw, buffer_size=1024 * 1024))

    @property
    def last_modified(self) -> Optional[str]:
        return self.raw.last_modified

    def names(self) -> list[str]:
        return self.zip.namelist()

    def _refuse_if_larger(self, info: zipfile.ZipInfo, limit: int) -> None:
        """Refuse a member whose directory entry states a size above ``limit``, before any of it is read."""
        if info.file_size > limit or info.compress_size > limit:
            raise FetchError(self.url, None, f"member {info.filename} is stated to hold {info.file_size} bytes "
                                             f"({info.compress_size} compressed), more than the {limit} expected")

    def read(self, name: str, *, max_bytes: int = MAX_MEMBER_BYTES) -> bytes:
        """One whole member, refused before it is read if its directory entry states more than ``max_bytes``.

        It is inflated a megabyte at a time: ``zipfile.ZipFile.read`` inflates a member's whole stream at once and
        only then cuts it to the stated size, so a member stated to be small could still fill the memory. ``zipfile``
        stops at the stated size and checks the CRC; a member that ends short of that size is refused here."""
        info = self.zip.getinfo(name)
        self._refuse_if_larger(info, max_bytes)
        out = bytearray()
        with self.zip.open(info) as handle:
            while chunk := handle.read(1024 * 1024):
                out += chunk
        if len(out) != info.file_size:
            raise FetchError(self.url, None, f"{name} does not inflate to the {info.file_size} bytes its directory entry states")
        return bytes(out)

    def lines(self, name: str, encoding: str = "latin-1", *, max_line: int = MAX_LINE_BYTES) -> Iterator[str]:
        """The lines of a member, read as they are needed, so that only its head is inflated when only its head
        is wanted. A line longer than ``max_line`` bytes ends the read with an error."""
        with self.zip.open(name) as handle:
            while True:
                raw = handle.readline(max_line + 1)
                if not raw:
                    return
                if len(raw) > max_line and not raw.endswith(b"\n"):
                    raise FetchError(self.url, None, f"member {name} has a line longer than {max_line} bytes")
                yield raw.decode(encoding).rstrip("\r\n")

    def head_lines(self, name: str, limit: int, encoding: str = "latin-1") -> list[str]:
        """Return the first ``limit`` lines of a member without inflating all of it."""
        lines: list[str] = []
        reader = self.lines(name, encoding)
        try:
            for line in reader:
                lines.append(line)
                if len(lines) >= limit:
                    break
        finally:
            reader.close()
        return lines

    def member_bytes(self, name: str, *, max_bytes: int = MAX_TEXT_MEMBER_BYTES) -> bytes:
        """Fetch one member with a single exact ranged GET (thread-safe).

        Used for the thousands of small ``.lob`` members in the California
        archive, where block-aligned reads would transfer far more than needed.
        A member stated to be larger than ``max_bytes`` is refused before it is
        fetched, and a member that does not inflate to exactly the size its
        directory entry states is refused without inflating more than one byte
        beyond that size.
        """
        info = self.zip.getinfo(name)
        self._refuse_if_larger(info, max_bytes)
        # Local header: 30 fixed bytes + file name + extra field (length only
        # known from the local header itself, so over-read a little).
        slack = 30 + len(info.filename.encode("utf-8")) + 512
        start = info.header_offset
        end = min(start + slack + info.compress_size, self.raw.size) - 1
        result = self.raw.fetcher.get_range(self.url, start, end, total=self.raw.size)
        data = result.content
        self.raw.bytes_fetched += len(data)
        if data[:4] != b"PK\x03\x04":
            raise FetchError(self.url, result.status, f"bad local header for {name}")
        name_len, extra_len = struct.unpack("<HH", data[26:30])
        body = data[30 + name_len + extra_len : 30 + name_len + extra_len + info.compress_size]
        if len(body) != info.compress_size:
            raise FetchError(self.url, result.status, f"short member read for {name}")
        if info.compress_type == zipfile.ZIP_STORED:
            raw = body
            complete = True
        elif info.compress_type == zipfile.ZIP_DEFLATED:
            inflater = zlib.decompressobj(-15)
            raw = inflater.decompress(body, info.file_size + 1)
            complete = inflater.eof
        else:
            raise FetchError(self.url, result.status, f"unsupported compression for {name}")
        if len(raw) != info.file_size or not complete:
            raise FetchError(self.url, result.status, f"{name} does not inflate to the {info.file_size} bytes its directory entry states")
        if zlib.crc32(raw) & 0xFFFFFFFF != info.CRC:
            raise FetchError(self.url, result.status, f"CRC mismatch for {name}")
        return raw
