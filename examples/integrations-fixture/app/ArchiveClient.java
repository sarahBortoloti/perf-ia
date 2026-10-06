@FeignClient(name="archive", url="${archive.url}")
interface ArchiveClient { @GetMapping("/archive") String read(); }
