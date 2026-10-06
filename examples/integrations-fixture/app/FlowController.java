@RestController
class FlowController {
  LoginClient login;
  ArchiveClient archive;
  PaymentGateway gateway;
  @GetMapping("/flow") String run() {
    login.login();
    gateway.execute();
    archive.read();
    return "fictional";
  }
}
