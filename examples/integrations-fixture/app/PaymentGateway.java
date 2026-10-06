class PaymentGateway {
  RestTemplate http;
  @Value("${gateway.url}") String address;
  String execute() { return http.postForObject(address, "fictional", String.class); }
}
